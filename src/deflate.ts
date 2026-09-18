/**
 * DEFLATE 压缩器（RFC 1951）。
 *
 * - LZ77：32768 滑动窗口 + 哈希链，3 字节起配，带 lazy matching，
 *   参数对齐 zlib 默认级别 6（good_len=8 / max_lazy=16 /
 *   nice_len=128 / max_chain=128）。
 * - 三种块类型都能产出：每个块在收尾时按精确比特成本选择
 *   STORED / FIXED / DYNAMIC 中最省的一种。
 * - seekInterval 配置跳转粒度：每累计 seekInterval 个原始字节就
 *   强制收尾当前块、重置哈希另起一块，并记录索引点
 *   （原始偏移 + DEFLATE 流位偏移）。跨越边界的匹配被切开：
 *   旧跨度内的半截编码为匹配（≥3 字节），新跨度内的半截按字面量
 *   输出，保证跳转解压时不会引用跨度起点之前的数据。
 *
 * 窗口缓冲采用 zlib 的 64K 线性布局：扫描位置始终位于后半段，
 * 需要比较的 32K 历史在前半段，匹配与前瞻都可以线性读取，
 * 扫描位置越过边界时整体 slide。
 *
 * 输入流式：write() 可多次调用，finish() 收尾。
 * 最后补一个空的 BFINAL STORED 块，使流在字节边界结束，
 * 方便 gzip 尾部直接按字节追加。
 */

import { BitWriter } from './bitstream';
import {
  buildCanonicalCodes,
  buildLengths,
  fixedDistLengths,
  fixedLitLengths,
} from './huffman';
import {
  BLOCK_MAX_BYTES,
  BLOCK_MAX_SYMBOLS,
  CL_ORDER,
  DIST_BASE,
  DIST_EXTRA,
  distanceCode,
  END_OF_BLOCK,
  LENGTH_BASE,
  LENGTH_EXTRA,
  lengthCode,
  MAX_CODE_LEN,
  MAX_MATCH,
  MAX_WBITS,
  NUM_CL_CODES,
  NUM_DIST_CODES,
  NUM_LIT_CODES,
} from './tables';

/** 一条索引记录：跳转点处的原始偏移与 DEFLATE 流位偏移。 */
export interface SeekEntry {
  rawOffset: number;
  bitOffset: number;
}

export interface DeflaterOptions {
  /** 跳转间隔（原始字节）。Infinity（默认）表示不产生跳转点。 */
  seekInterval?: number;
  /** 哈希链最大长度（默认 128，对齐 zlib level 6）。 */
  maxChain?: number;
  /** 达到多长就提前停止链搜索（默认 128，对齐 zlib level 6）。 */
  niceLength?: number;
  /** 进入“缩短链搜索”状态的阈值（good length，默认 8）。 */
  goodLength?: number;
  /** lazy matching 的长度阈值（默认 16）。 */
  maxLazy?: number;
}

// 哈希参数（对齐 zlib：15 位哈希，shift 5）
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
const HASH_MASK = HASH_SIZE - 1;
const HASH_SHIFT = 5;
const WMSK = MAX_WBITS - 1;
const DOUBLE_W = 2 * MAX_WBITS;

function hash3(a: number, b: number, c: number): number {
  return (((a << 10) ^ (b << HASH_SHIFT) ^ c) & HASH_MASK) >>> 0;
}

interface RleRun {
  sym: number;
  count: number;
}

/** 把码长序列按 RFC 1951 §3.2.7 的 16/17/18 规则做游程编码。 */
export function rleCodeLengths(lengths: Uint8Array, count: number): RleRun[] {
  const runs: RleRun[] = [];
  let i = 0;
  while (i < count) {
    const v = lengths[i];
    let run = 1;
    while (i + run < count && lengths[i + run] === v) run++;
    if (v === 0) {
      let remain = run;
      while (remain > 0) {
        if (remain >= 11) {
          const take = Math.min(remain, 138);
          runs.push({ sym: 18, count: take });
          remain -= take;
        } else if (remain >= 3) {
          runs.push({ sym: 17, count: remain });
          remain = 0;
        } else {
          // 1..2 个零：符号 0 是“一个字面码长”，必须逐个输出
          for (let k = 0; k < remain; k++) runs.push({ sym: 0, count: 1 });
          remain = 0;
        }
      }
    } else if (run >= 4) {
      runs.push({ sym: v, count: 1 });
      let remain = run - 1;
      while (remain > 0) {
        const take = Math.min(remain, 6);
        if (take >= 3) {
          runs.push({ sym: 16, count: take });
          remain -= take;
        } else {
          for (let k = 0; k < remain; k++) runs.push({ sym: v, count: 1 });
          remain = 0;
        }
      }
    } else {
      for (let k = 0; k < run; k++) runs.push({ sym: v, count: 1 });
    }
    i += run;
  }
  return runs;
}

export class Deflater {
  readonly bitWriter: BitWriter;
  readonly seekInterval: number;
  readonly maxChain: number;
  readonly niceLength: number;
  readonly goodLength: number;
  readonly maxLazy: number;
  readonly index: SeekEntry[] = [];

  // 64K 线性窗口
  private window = new Uint8Array(DOUBLE_W);
  private head = new Int32Array(HASH_SIZE).fill(-1);
  private prev = new Int32Array(MAX_WBITS).fill(-1);
  private pos = 0; // 下一个空闲字节的缓冲位置（0..2*MAX_WBITS）
  private scanPos = 0; // 下一个待扫描位置（缓冲相对）
  private slideBase = 0; // 缓冲位置 0 对应的原始绝对偏移
  private spanPos = 0; // 当前跳转跨度起点（缓冲相对）
  private spanStartRaw = 0; // 当前跳转跨度起点（原始偏移）

  // 块内已输出符号缓冲
  private symLit = new Uint16Array(BLOCK_MAX_SYMBOLS); // 字面量字节或长度码
  private symLenExtra = new Uint16Array(BLOCK_MAX_SYMBOLS);
  private symDist = new Uint16Array(BLOCK_MAX_SYMBOLS); // 0xFFFF 表示字面量
  private symDistExtra = new Uint16Array(BLOCK_MAX_SYMBOLS);
  private symCount = 0;
  private blockRaw = new Uint8Array(BLOCK_MAX_BYTES + MAX_MATCH);
  private blockRawLen = 0;

  // lazy matching 状态
  private pendingPos = -1;
  private pendingLen = 0;
  private pendingDist = 0;

  private rawTotal = 0;
  private finished = false;

  constructor(bitWriter?: BitWriter, options: DeflaterOptions = {}) {
    this.bitWriter = bitWriter ?? new BitWriter();
    this.seekInterval = options.seekInterval ?? Infinity;
    this.maxChain = options.maxChain ?? 128;
    this.niceLength = options.niceLength ?? 128;
    this.goodLength = options.goodLength ?? 8;
    this.maxLazy = options.maxLazy ?? 16;
    if (this.seekInterval !== Infinity) {
      this.index.push({ rawOffset: 0, bitOffset: 0 });
    }
  }

  write(input: Uint8Array): void {
    if (this.finished) throw new Error('Deflater already finished');
    let off = 0;
    while (off < input.length) {
      // 当可用空间不足以再放 MAX_WBITS 字节时先 slide。
      // 不变量：扫描位置最多滞后 pos MAX_MATCH-1 字节，
      // slide 后所有比较（历史 32K + 前瞻 258）都落在 64K 内。
      if (this.pos + MAX_WBITS > DOUBLE_W) {
        this.resolvePendingBeforeSlide();
        this.slideWindow();
      }
      const n = Math.min(input.length - off, DOUBLE_W - this.pos);
      this.window.set(input.subarray(off, off + n), this.pos);
      this.pos += n;
      this.rawTotal += n;
      off += n;
      this.scanAvailable(false);
    }
  }

  finish(): void {
    if (this.finished) return;
    this.scanAvailable(true);
    this.flushBlock();
    // 记录流结束点（此刻尚未写最终空块）。若 rawTotal 恰为 interval 倍数，
    // 该点同时也是下一个（不存在的）跨度起点；否则它就是最后跨度的终点。
    // 两种情况下 rawOffset 都等于 rawTotal，seek.ts 据此区分。
    if (this.seekInterval !== Infinity) {
      this.index.push({ rawOffset: this.rawTotal, bitOffset: this.bitWriter.bitOffset });
    }
    // 最终块：空的 BFINAL STORED，保证字节对齐收尾
    const bw = this.bitWriter;
    bw.writeBits(1, 1);
    bw.writeBits(0, 2);
    bw.alignToByte();
    bw.writeAlignedUint16LE(0);
    bw.writeAlignedUint16LE(0xffff);
    this.finished = true;
  }

  private slideWindow(): void {
    this.window.copyWithin(0, MAX_WBITS, DOUBLE_W);
    this.pos -= MAX_WBITS;
    this.scanPos -= MAX_WBITS;
    this.spanPos -= MAX_WBITS;
    for (let h = 0; h < HASH_SIZE; h++) {
      const v = this.head[h];
      this.head[h] = v >= MAX_WBITS ? v - MAX_WBITS : -1;
    }
    for (let i = 0; i < MAX_WBITS; i++) {
      const v = this.prev[i];
      this.prev[i] = v >= MAX_WBITS ? v - MAX_WBITS : -1;
    }
    this.slideBase += MAX_WBITS;
  }

  private resolvePendingBeforeSlide(): void {
    if (this.pendingPos < 0) return;
    const b = this.emitPendingMatch();
    this.pendingPos = -1;
    this.pendingLen = 0;
    // pendingPos 已在成为挂起项时插入；其后的内部位置都未插入
    this.fillInteriorHashes(b, b.start);
    this.scanPos = b.start + b.len;
  }

  /**
   * 为匹配跳过的内部位置补哈希。
   * 每个位置必须恰好插入一次，否则第二次插入会让 prev[p]=p 形成
   * 哈希自链（链遍历死循环）。规则：
   *  - 只插入大于当前扫描位置 cur 的（cur 本迭代已插入）；
   *  - 跨界匹配只补新跨度内的位置（旧跨度哈希已清空）。
   */
  private fillInteriorHashes(b: MatchEmit, cur: number): void {
    for (let k = 1; k < b.len; k++) {
      const p = b.start + k;
      if (p <= cur) continue;
      if (b.newSpanStart === Infinity || p >= b.newSpanStart) this.insertHash(p);
    }
  }

  // ---------------------------------------------------------------------------
  // LZ77
  // ---------------------------------------------------------------------------

  private insertHash(absPos: number): void {
    const slot = absPos & WMSK;
    const h = hash3(this.window[absPos], this.window[absPos + 1], this.window[absPos + 2]);
    this.prev[slot] = this.head[h];
    this.head[h] = absPos;
  }

  private findMatch(cur: number, available: number): { len: number; dist: number } {
    const h = hash3(this.window[cur], this.window[cur + 1], this.window[cur + 2]);
    let chainLen = this.maxChain;
    if (this.pendingLen >= this.goodLength) chainLen >>>= 2;
    let bestLen = 2;
    let bestDist = 0;
    const maxLen = Math.min(available, MAX_MATCH);
    let candidate = this.head[h];
    const minPos = Math.max(this.spanPos, cur - MAX_WBITS);
    while (candidate >= minPos) {
      if (
        this.window[candidate + bestLen] === this.window[cur + bestLen] &&
        this.window[candidate] === this.window[cur] &&
        this.window[candidate + 1] === this.window[cur + 1]
      ) {
        let len = 2;
        while (len < maxLen && this.window[candidate + len] === this.window[cur + len]) len++;
        if (len > bestLen) {
          bestLen = len;
          bestDist = cur - candidate;
          if (len >= maxLen || len >= this.niceLength) break;
        }
      }
      if (--chainLen === 0) break;
      const next = this.prev[candidate & WMSK];
      if (next !== -1 && next >= candidate) {
        throw new Error(`hash chain not strictly decreasing at ${candidate}->${next} (cur=${cur})`);
      }
      candidate = next;
    }
    return bestLen >= 3 && bestDist > 0 ? { len: bestLen, dist: bestDist } : { len: 0, dist: 0 };
  }

  private scanAvailable(endOfInput: boolean): void {
    // 非结束状态保留 MAX_MATCH-1 字节前瞻
    const limit = endOfInput ? this.pos : this.pos - (MAX_MATCH - 1);
    let cur = this.scanPos;

    while (cur < limit) {
      const available = this.pos - cur;
      let mLen = 0;
      let mDist = 0;
      if (available >= 3) {
        // 必须在插入 cur 之前查询，否则 cur 自己会出现在候选链头
        const m = this.findMatch(cur, available);
        mLen = m.len;
        mDist = m.dist;
      }
      this.insertHash(cur);
      if (this.pendingPos >= 0) {
        if (mLen > this.pendingLen) {
          // 当前位置匹配更好：挂起点降为字面量
          const spanBefore = this.spanPos;
          this.outputLiteral(this.pendingPos);
          if (this.spanPos !== spanBefore) {
            // 挂起点的字面量恰好触发了跨度切换：当前点不能引用旧跨度，
            // 也按字面量处理，并为新跨度重新播种哈希
            this.insertHash(cur);
            this.outputLiteral(cur);
            this.pendingPos = -1;
            this.pendingLen = 0;
          } else {
            this.pendingPos = cur;
            this.pendingLen = mLen;
            this.pendingDist = mDist;
          }
        } else {
          const b = this.emitPendingMatch();
          this.pendingPos = -1;
          this.pendingLen = 0;
          this.fillInteriorHashes(b, cur);
          cur = b.start + b.len - 1; // 与循环末尾 +1 合计跳到匹配之后
        }
      } else if (mLen >= 3 && mLen < this.maxLazy) {
        this.pendingPos = cur;
        this.pendingLen = mLen;
        this.pendingDist = mDist;
      } else if (mLen >= 3) {
        const b = this.outputMatch(cur, mLen, mDist);
        this.fillInteriorHashes(b, cur);
        cur += b.len - 1;
      } else {
        this.outputLiteral(cur);
      }
      cur++;
    }

    if (endOfInput) {
      if (this.pendingPos >= 0) {
        const b = this.emitPendingMatch();
        this.pendingPos = -1;
        this.pendingLen = 0;
        cur = b.start + b.len;
      }
      while (cur < this.pos) {
        this.outputLiteral(cur);
        cur++;
      }
    }

    this.scanPos = cur;
  }

  private emitPendingMatch(): MatchEmit {
    const pp = this.pendingPos;
    const b = this.outputMatch(pp, this.pendingLen, this.pendingDist);
    return b;
  }

  // ---------------------------------------------------------------------------
  // 符号输出（含跳转边界切分）
  // ---------------------------------------------------------------------------

  private ensureCapacity(nbytes: number): void {
    if (this.blockRawLen + nbytes > BLOCK_MAX_BYTES || this.symCount + 1 > BLOCK_MAX_SYMBOLS) {
      this.flushBlock();
    }
  }

  private outputLiteral(absPos: number): void {
    if (this.seekInterval !== Infinity && absPos - this.spanPos >= this.seekInterval) {
      this.flushBlock();
      this.resetHashForSpan(absPos);
    }
    this.ensureCapacity(1);
    const b = this.window[absPos];
    this.symLit[this.symCount] = b;
    this.symDist[this.symCount] = 0xffff;
    this.symCount++;
    this.blockRaw[this.blockRawLen++] = b;
  }

  /**
   * 输出一个匹配。若匹配跨过跳转边界，切成：
   * 旧跨度内的前缀（>=3 才编码成匹配，否则字面量），
   * 新跨度内的后缀（全部按字面量，避免引用跨度起点之前的数据）。
   */
  private outputMatch(absPos: number, len: number, dist: number): MatchEmit {
    if (this.seekInterval !== Infinity) {
      const intoSpan = absPos - this.spanPos;
      if (intoSpan + len > this.seekInterval) {
        const prefix = this.seekInterval - intoSpan;
        this.emitMatchPiece(absPos, prefix, dist);
        this.flushBlock();
        this.resetHashForSpan(absPos + prefix);
        for (let k = prefix; k < len; k++) this.outputLiteral(absPos + k);
        return { start: absPos, len, newSpanStart: absPos + prefix };
      }
    }
    this.emitMatchPiece(absPos, len, dist);
    return { start: absPos, len, newSpanStart: Infinity };
  }

  private emitMatchPiece(absPos: number, len: number, dist: number): void {
    if (len < 3) {
      for (let k = 0; k < len; k++) this.outputLiteral(absPos + k);
      return;
    }
    this.ensureCapacity(len);
    const lc = lengthCode(len);
    const dc = distanceCode(dist);
    this.symLit[this.symCount] = lc;
    this.symLenExtra[this.symCount] = len - LENGTH_BASE[lc - 257];
    this.symDist[this.symCount] = dc;
    this.symDistExtra[this.symCount] = dist - DIST_BASE[dc];
    this.symCount++;
    this.blockRaw.set(this.window.subarray(absPos, absPos + len), this.blockRawLen);
    this.blockRawLen += len;
  }

  private resetHashForSpan(absPos: number): void {
    this.head.fill(-1);
    this.spanPos = absPos;
    this.spanStartRaw = absPos + this.slideBase;
    this.index.push({
      rawOffset: this.spanStartRaw,
      bitOffset: this.bitWriter.bitOffset,
    });
  }

  private flushBlock(): void {
    if (this.symCount === 0 && this.blockRawLen === 0) return;
    const rawLen = this.blockRawLen;
    const costs = this.blockCosts(rawLen);
    if (costs.stored <= costs.fixed && costs.stored <= costs.dynamic) {
      this.emitStoredBlock(rawLen);
    } else if (costs.fixed <= costs.dynamic) {
      this.emitFixedBlock();
    } else {
      this.emitDynamicBlock();
    }
    this.symCount = 0;
    this.blockRawLen = 0;
  }

  // ---------------------------------------------------------------------------
  // 块类型成本与产出
  // ---------------------------------------------------------------------------

  private blockCosts(rawLen: number): { stored: number; fixed: number; dynamic: number } {
    const alignPad = (8 - (this.bitWriter.bitOffset % 8)) % 8;
    const stored = 3 + alignPad + 32 + rawLen * 8;

    const fixLL = fixedLitLengths();
    let fixed = 3 + fixLL[END_OF_BLOCK];
    for (let i = 0; i < this.symCount; i++) {
      const s = this.symLit[i];
      fixed += fixLL[s];
      const dc = this.symDist[i];
      if (dc !== 0xffff) fixed += 5 + DIST_EXTRA[dc] + LENGTH_EXTRA[s - 257];
    }

    const { hlit, hdist, llLen, dLen } = this.collectFrequencies();
    const runs = this.codeLengthRuns(llLen, dLen, hlit, hdist);
    const clFreq = new Int32Array(NUM_CL_CODES);
    for (const r of runs) clFreq[r.sym]++;
    const clLen = buildLengths(clFreq, NUM_CL_CODES, 7);
    let hclen = 0;
    for (let k = CL_ORDER.length - 1; k >= 0; k--) {
      if (clLen[CL_ORDER[k]] !== 0) {
        hclen = k + 1;
        break;
      }
    }
    let dynamic = 3 + 5 + 5 + 4 + hclen * 3;
    for (const r of runs) {
      dynamic += clLen[r.sym];
      if (r.sym === 16) dynamic += 2;
      else if (r.sym === 17) dynamic += 3;
      else if (r.sym === 18) dynamic += 7;
    }
    dynamic += llLen[END_OF_BLOCK];
    for (let i = 0; i < this.symCount; i++) {
      const s = this.symLit[i];
      dynamic += llLen[s];
      const dc = this.symDist[i];
      if (dc !== 0xffff) dynamic += dLen[dc] + DIST_EXTRA[dc] + LENGTH_EXTRA[s - 257];
    }
    return { stored, fixed, dynamic };
  }

  private collectFrequencies(): {
    hlit: number;
    hdist: number;
    llLen: Uint8Array;
    dLen: Uint8Array;
  } {
    const litFreq = new Int32Array(NUM_LIT_CODES);
    const distFreq = new Int32Array(NUM_DIST_CODES);
    litFreq[END_OF_BLOCK] = 1;
    let hasDist = false;
    for (let i = 0; i < this.symCount; i++) {
      litFreq[this.symLit[i]]++;
      const dc = this.symDist[i];
      if (dc !== 0xffff) {
        distFreq[dc]++;
        hasDist = true;
      }
    }
    const llLen = buildLengths(litFreq, NUM_LIT_CODES, MAX_CODE_LEN);
    // 返回码数量（含 EOB）：nL = HLIT + 257，取值 257..286
    let nL = NUM_LIT_CODES;
    while (nL > 257 && llLen[nL - 1] === 0) nL--;
    let dLen: Uint8Array;
    let nD: number;
    if (!hasDist) {
      dLen = new Uint8Array(NUM_DIST_CODES);
      nD = 1; // HDIST=0，仍传输 1 个（全 0 的）距离码长
    } else {
      dLen = buildLengths(distFreq, NUM_DIST_CODES, MAX_CODE_LEN);
      nD = NUM_DIST_CODES;
      while (nD > 1 && dLen[nD - 1] === 0) nD--;
    }
    return { hlit: nL, hdist: nD, llLen, dLen };
  }

  private codeLengthRuns(llLen: Uint8Array, dLen: Uint8Array, hlit: number, hdist: number): RleRun[] {
    const seq = new Uint8Array(hlit + hdist);
    seq.set(llLen.subarray(0, hlit), 0);
    seq.set(dLen.subarray(0, hdist), hlit);
    return rleCodeLengths(seq, seq.length);
  }

  private emitStoredBlock(rawLen: number): void {
    if (rawLen > 65535) throw new Error('stored block too large');
    const bw = this.bitWriter;
    bw.writeBits(0, 1); // BFINAL=0，最终块由 finish 的空 STORED 承担
    bw.writeBits(0, 2);
    bw.alignToByte();
    bw.writeAlignedUint16LE(rawLen);
    bw.writeAlignedUint16LE(~rawLen & 0xffff);
    bw.writeAlignedBytes(this.blockRaw, 0, rawLen);
  }

  private emitSymbol(s: number, i: number, llRev: Uint16Array, llLen: Uint8Array,
    dRev: Uint16Array, dLen: Uint8Array): void {
    const bw = this.bitWriter;
    bw.writeBits(llRev[s], llLen[s]);
    if (s >= 257) {
      const le = LENGTH_EXTRA[s - 257];
      if (le > 0) bw.writeBits(this.symLenExtra[i], le);
      const dc = this.symDist[i];
      if (dc !== 0xffff) {
        bw.writeBits(dRev[dc], dLen[dc]);
        const de = DIST_EXTRA[dc];
        if (de > 0) bw.writeBits(this.symDistExtra[i], de);
      }
    }
  }

  private emitFixedBlock(): void {
    const bw = this.bitWriter;
    bw.writeBits(0, 1);
    bw.writeBits(1, 2);
    const llLen = fixedLitLengths();
    const llCodes = buildCanonicalCodes(llLen);
    const dLen = fixedDistLengths();
    const dCodes = buildCanonicalCodes(dLen);
    for (let i = 0; i < this.symCount; i++) {
      this.emitSymbol(this.symLit[i], i, llCodes.reversed, llLen, dCodes.reversed, dLen);
    }
    bw.writeBits(llCodes.reversed[END_OF_BLOCK], llLen[END_OF_BLOCK]);
  }

  private emitDynamicBlock(): void {
    const bw = this.bitWriter;
    bw.writeBits(0, 1);
    bw.writeBits(2, 2);
    const { hlit, hdist, llLen, dLen } = this.collectFrequencies();
    bw.writeBits(hlit - 257, 5); // HLIT = 码数量 - 257
    bw.writeBits(hdist - 1, 5); // HDIST = 码数量 - 1

    const runs = this.codeLengthRuns(llLen, dLen, hlit, hdist);
    const clFreq = new Int32Array(NUM_CL_CODES);
    for (const r of runs) clFreq[r.sym]++;
    const clLen = buildLengths(clFreq, NUM_CL_CODES, 7);
    let hclen = 0;
    for (let k = CL_ORDER.length - 1; k >= 0; k--) {
      if (clLen[CL_ORDER[k]] !== 0) {
        hclen = k + 1;
        break;
      }
    }
    bw.writeBits(hclen - 4, 4); // HCLEN = 码长码数量 - 4
    for (let k = 0; k < hclen; k++) bw.writeBits(clLen[CL_ORDER[k]], 3);

    const clCodes = buildCanonicalCodes(clLen);
    for (const r of runs) {
      bw.writeBits(clCodes.reversed[r.sym], clLen[r.sym]);
      if (r.sym === 16) bw.writeBits(r.count - 3, 2);
      else if (r.sym === 17) bw.writeBits(r.count - 3, 3);
      else if (r.sym === 18) bw.writeBits(r.count - 11, 7);
    }

    const llCodes = buildCanonicalCodes(llLen);
    const dCodes = buildCanonicalCodes(dLen);
    for (let i = 0; i < this.symCount; i++) {
      this.emitSymbol(this.symLit[i], i, llCodes.reversed, llLen, dCodes.reversed, dLen);
    }
    bw.writeBits(llCodes.reversed[END_OF_BLOCK], llLen[END_OF_BLOCK]);
  }
}

interface MatchEmit {
  start: number;
  len: number;
  newSpanStart: number;
}

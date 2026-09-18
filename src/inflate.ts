/**
 * DEFLATE 解压器（RFC 1951）。
 *
 * 能解码任意合法 DEFLATE 流：三种块类型（STORED / FIXED / DYNAMIC）、
 * 非字节对齐的块交界、完整的动态码头（16/17/18 码长游程）、
 * 重叠式距离回指（distance < length）。位流按 LSB 读取。
 *
 * 解码表是两级查表（见 huffman.ts）。
 * 距离回指通过 32K 环形窗口完成，避免在长重复串上退化为平方复杂度。
 * 支持输出上限 maxOutput：达到后在符号边界处干净停止，
 * 供按区间解压只取需要的字节。
 */

import { BitReader } from './bitstream';
import { DecodeTable, fixedDistLengths, fixedLitLengths } from './huffman';
import {
  CL_ORDER,
  DIST_BASE,
  DIST_EXTRA,
  END_OF_BLOCK,
  LENGTH_BASE,
  LENGTH_EXTRA,
  MAX_WBITS,
} from './tables';

export class Inflater {
  private reader: BitReader;
  private out: OutputBuffer;
  private maxOutput: number;

  constructor(reader: BitReader, maxOutput = Infinity) {
    this.reader = reader;
    this.out = new OutputBuffer();
    this.maxOutput = maxOutput;
  }

  /** 从位流当前位置开始解码，到 BFINAL 块结束或达到输出上限为止。 */
  run(): Uint8Array {
    let bfinal = 0;
    while (bfinal === 0) {
      if (this.out.length >= this.maxOutput) break;
      bfinal = this.reader.readBits(1);
      const btype = this.reader.readBits(2);
      if (btype === 0) this.inflateStored();
      else if (btype === 1) this.inflateFixed();
      else if (btype === 2) this.inflateDynamic();
      else throw new Error('invalid DEFLATE block type 3 (reserved)');
    }
    return this.out.toBytes();
  }

  private inflateStored(): void {
    const r = this.reader;
    r.alignToByte();
    const len = r.readAlignedUint16LE();
    const nlen = r.readAlignedUint16LE();
    if ((len ^ nlen) !== 0xffff) {
      throw new Error('invalid stored block: LEN/NLEN mismatch');
    }
    const data = r.readAlignedBytes(len);
    const room = this.maxOutput - this.out.length;
    this.out.append(data.subarray(0, Math.min(data.length, room)));
  }

  private inflateFixed(): void {
    const lit = new DecodeTable(fixedLitLengths());
    const dist = new DecodeTable(fixedDistLengths());
    this.inflateCodes(lit, dist);
  }

  private inflateDynamic(): void {
    const r = this.reader;
    const hlit = r.readBits(5) + 257;
    const hdist = r.readBits(5) + 1;
    const hclen = r.readBits(4) + 4;

    const clLengths = new Uint8Array(19);
    for (let i = 0; i < hclen; i++) {
      clLengths[CL_ORDER[i]] = r.readBits(3);
    }
    const clTable = new DecodeTable(clLengths);

    const total = hlit + hdist;
    const lengths = new Uint8Array(total);
    let i = 0;
    while (i < total) {
      const sym = this.decodeSymbol(clTable);
      if (sym < 16) {
        lengths[i++] = sym;
      } else if (sym === 16) {
        if (i === 0) throw new Error('invalid dynamic block: code 16 at start');
        const repeat = r.readBits(2) + 3;
        const v = lengths[i - 1];
        if (i + repeat > total) throw new Error('invalid dynamic block: code length run overflow');
        lengths.fill(v, i, i + repeat);
        i += repeat;
      } else if (sym === 17) {
        const repeat = r.readBits(3) + 3;
        if (i + repeat > total) throw new Error('invalid dynamic block: code length run overflow');
        i += repeat;
      } else {
        const repeat = r.readBits(7) + 11;
        if (i + repeat > total) throw new Error('invalid dynamic block: code length run overflow');
        i += repeat;
      }
    }

    const litTable = new DecodeTable(lengths.subarray(0, hlit));
    const distTable = new DecodeTable(lengths.subarray(hlit, total));
    this.inflateCodes(litTable, distTable);
  }

  private decodeSymbol(table: DecodeTable): number {
    const r = this.reader;
    if (r.availableBits <= 0) {
      throw new Error('unexpected end of DEFLATE stream');
    }
    r.refill();
    // 流末尾剩余位可能不足 maxLen：用 peek(15) 时高位补零，
    // 解码表对“未覆盖/非法”的比特串返回 -1。真正的结束符（如固定
    // 码表的 EOB 只有 7 位）即使在仅剩 7 位时也能正确解出。
    const sym = table.decode(r.peek(15));
    r.drop(table.lengths[sym]);
    return sym;
  }

  private inflateCodes(lit: DecodeTable, dist: DecodeTable): void {
    const r = this.reader;
    const out = this.out;
    const maxOut = this.maxOutput;

    while (out.length < maxOut) {
      const sym = this.decodeSymbol(lit);

      if (sym < 256) {
        out.putByte(sym);
      } else if (sym === END_OF_BLOCK) {
        return;
      } else if (sym > 285) {
        throw new Error('invalid length symbol in DEFLATE stream');
      } else {
        const li = sym - 257;
        const length = LENGTH_BASE[li] + (LENGTH_EXTRA[li] > 0 ? r.readBits(LENGTH_EXTRA[li]) : 0);

        if (dist.maxLen === 0) throw new Error('distance symbol required but no distance codes defined');
        const dsym = this.decodeSymbol(dist);
        if (dsym > 29) throw new Error('invalid distance symbol in DEFLATE stream');
        const distance =
          DIST_BASE[dsym] + (DIST_EXTRA[dsym] > 0 ? r.readBits(DIST_EXTRA[dsym]) : 0);

        if (distance > out.length || distance > MAX_WBITS) {
          throw new Error('invalid back-reference distance in DEFLATE stream');
        }
        out.copyBack(length, distance, maxOut);
      }
    }
  }
}

/**
 * 输出缓冲：
 * - 分块列表累积结果（避免大数组重复扩容）；
 * - 32K 环形窗口保存最近输出，距离回指 O(1) 定位，
 *   重叠回指（distance < length）逐字节复制。
 */
class OutputBuffer {
  private chunks: Uint8Array[] = [];
  private current = new Uint8Array(1 << 16);
  private curLen = 0;
  private total = 0;
  private ring = new Uint8Array(MAX_WBITS);

  get length(): number {
    return this.total;
  }

  private ringPut(b: number): void {
    this.ring[this.total & (MAX_WBITS - 1)] = b;
  }

  putByte(b: number): void {
    if (this.curLen === this.current.length) {
      this.chunks.push(this.current);
      this.current = new Uint8Array(1 << 16);
      this.curLen = 0;
    }
    this.current[this.curLen++] = b;
    this.ringPut(b);
    this.total++;
  }

  append(data: Uint8Array): void {
    let off = 0;
    while (off < data.length) {
      if (this.curLen === this.current.length) {
        this.chunks.push(this.current);
        this.current = new Uint8Array(1 << 16);
        this.curLen = 0;
      }
      const n = Math.min(data.length - off, this.current.length - this.curLen);
      this.current.set(data.subarray(off, off + n), this.curLen);
      this.curLen += n;
      off += n;
    }
    // 更新环形窗口（分两段处理回绕）
    const start = this.total;
    for (let k = 0; k < data.length; k++) {
      this.ring[(start + k) & (MAX_WBITS - 1)] = data[k];
    }
    this.total += data.length;
  }

  copyBack(length: number, distance: number, maxOut: number): void {
    const room = maxOut - this.total;
    const count = Math.min(length, room);
    for (let k = 0; k < count; k++) {
      // 每字节从 ring 取：当 distance < length 时，刚写入的字节
      // 已在 ring 中，天然支持重叠复制。
      const b = this.ring[(this.total - distance) & (MAX_WBITS - 1)];
      if (this.curLen === this.current.length) {
        this.chunks.push(this.current);
        this.current = new Uint8Array(1 << 16);
        this.curLen = 0;
      }
      this.current[this.curLen++] = b;
      this.ringPut(b);
      this.total++;
    }
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(this.total);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    out.set(this.current.subarray(0, this.curLen), off);
    return out;
  }
}

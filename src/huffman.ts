/**
 * 规范 Huffman 码（canonical Huffman）的构造与解码表。
 *
 * 码长生成使用 package-merge（Larmore–Hirschberg）：
 * 它等价于在“最大码长 maxLen”约束下的最优前缀码，
 * 产出的码长必然满足 Kraft 等式（完整树）。相比直接 Huffman
 * 再剪枝，package-merge 不会留下需要修补的越界码长。
 *
 * 规范码的赋值按 RFC 1951 §3.2.2：同码长内按符号序递增。
 * DEFLATE 的 Huffman 码按 MSB 先输出，所以写位流时要逐位反转，
 * 反转后的码随位流 LSB 打包读回来正好是 peek 的低 len 位。
 */

import { MAX_CODE_LEN } from './tables';

interface Item {
  w: number;
  sym: number; // >=0 表示叶子（硬币）；-1 表示包
  a: Item | null;
  b: Item | null;
  // 该 item 在“被选集合”中被需要的份数（码长 DP 用）
  demand: number;
}

function leaf(w: number, sym: number): Item {
  return { w, sym, a: null, b: null, demand: 0 };
}

function packageOf(a: Item, b: Item): Item {
  return { w: a.w + b.w, sym: -1, a, b, demand: 0 };
}

/**
 * 根据频度构造 DEFLATE 码长（最大 15 位）。
 * - 没有符号：返回全 0
 * - 只有一个符号：码长 1（DEFLATE 规定单个距离码也用 1 位）
 */
export function buildLengths(freq: ArrayLike<number>, n: number, maxLen = MAX_CODE_LEN): Uint8Array {
  const lengths = new Uint8Array(n);
  const present: number[] = [];
  for (let i = 0; i < n; i++) {
    if (freq[i] > 0) present.push(i);
  }
  const m = present.length;
  if (m === 0) return lengths;
  if (m === 1) {
    lengths[present[0]] = 1;
    return lengths;
  }
  if (m > 1 << maxLen) {
    throw new Error('too many symbols for the given maximum code length');
  }

  const coins = present.map((s) => leaf(freq[s], s));
  const compare = (x: Item, y: Item): number => (x.w < y.w ? -1 : x.w > y.w ? 1 : 0);

  // package-merge。记 M_j = P_{j-1} + 原始硬币（M_0 只有硬币），
  // P_j 为 M_j 排序后两两配对得到的包。保存每一层产出的 P_j。
  const packageLevels: Item[][] = [];
  let prev: Item[] = [];
  for (let level = 0; level < maxLen - 1; level++) {
    const items = prev.concat(coins);
    items.sort(compare);
    const next: Item[] = [];
    for (let i = 0; i + 1 < items.length; i += 2) {
      next.push(packageOf(items[i], items[i + 1]));
    }
    packageLevels.push(next); // P_level
    prev = next;
  }
  const finalItems = prev.concat(coins).sort(compare); // M_final = P_{L-2} + 硬币

  // 线性深度统计（把 DAG 当 DAG，不递归展开）：
  // 取 M_final 最小的 2m-2 项，各 demand=1；然后从最深的包开始，
  // 把每个包的 demand 传给它在 M_j 中的两个孩子（下层包或硬币）。
  // 硬币在所有层共享同一对象，demand 累加值即其码长。
  const take = 2 * m - 2;
  for (let i = 0; i < take; i++) finalItems[i].demand++;
  for (let level = packageLevels.length - 1; level >= 0; level--) {
    for (const it of packageLevels[level]) {
      if (it.demand > 0) {
        it.a!.demand += it.demand;
        it.b!.demand += it.demand;
        it.demand = 0;
      }
    }
  }
  for (const c of coins) lengths[c.sym] = c.demand;
  return lengths;
}

export interface CanonicalCodes {
  /** 规范码（MSB 顺序），码长为 0 的符号为 0。 */
  codes: Uint16Array;
  /** 逐位反转后的码，直接按 LSB 写入位流。 */
  reversed: Uint16Array;
  maxLen: number;
}

/** 码长 -> 规范码赋值（RFC 1951 §3.2.2）。 */
export function buildCanonicalCodes(lengths: ArrayLike<number>): CanonicalCodes {
  const n = lengths.length;
  const maxLen = Math.max(...Array.from(lengths as Uint8Array));
  const blCount = new Int32Array(MAX_CODE_LEN + 1);
  for (let i = 0; i < n; i++) blCount[lengths[i]]++;
  blCount[0] = 0;

  const nextCode = new Int32Array(MAX_CODE_LEN + 1);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }

  const codes = new Uint16Array(n);
  const reversed = new Uint16Array(n);
  for (let sym = 0; sym < n; sym++) {
    const len = lengths[sym];
    if (len === 0) continue;
    const c = nextCode[len]++;
    codes[sym] = c;
    reversed[sym] = reverseBits(c, len);
  }
  return { codes, reversed, maxLen };
}

export function reverseBits(value: number, bits: number): number {
  let v = value;
  let r = 0;
  for (let i = 0; i < bits; i++) {
    r = (r << 1) | (v & 1);
    v >>>= 1;
  }
  return r;
}

/**
 * 解码用两级查表。
 * 主表 PRIMARY_BITS 位；超过主表位数的长码进入对应子表。
 * 主表值 >= 0 为符号，< 0 表示需要查子表（索引 = -v-1）。
 */
const PRIMARY_BITS = 10;

interface SubTable {
  bits: number;
  table: Int32Array;
}

export class DecodeTable {
  readonly lengths: Uint8Array;
  readonly primaryBits: number;
  readonly table: Int32Array;
  readonly subs: SubTable[] = [];
  readonly maxLen: number;

  constructor(lengths: Uint8Array) {
    this.lengths = lengths;
    let maxLen = 0;
    for (let i = 0; i < lengths.length; i++) {
      if (lengths[i] > maxLen) maxLen = lengths[i];
    }
    this.maxLen = maxLen;
    const primaryBits = Math.min(maxLen, PRIMARY_BITS);
    this.primaryBits = primaryBits;
    // -1 表示非法码，避免和合法符号 0 混淆
    this.table = new Int32Array(1 << primaryBits).fill(-1);

    if (maxLen === 0) {
      // 全空表：合法地什么都解不出来（仅用于“无距离码”的占位）
      return;
    }

    // RFC 1951 允许不完整的码树（Kraft 和 < 1，未被覆盖的码字非法），
    // 解码器只需拒绝“过订阅”（Kraft 和 > 1）。
    // 不完整位置的表项保持 -1，真出现该比特串时按非法码报错。
    let kraft = 0;
    for (let i = 0; i < lengths.length; i++) {
      if (lengths[i] > 0) kraft += 1 << (MAX_CODE_LEN - lengths[i]);
    }
    if (kraft > 1 << MAX_CODE_LEN) {
      throw new Error('invalid Huffman code: over-subscribed');
    }

    const { reversed } = buildCanonicalCodes(lengths);

    // 按主表前缀收集长码（len > primaryBits）
    const groupLists: (number[] | null)[] = new Array(1 << primaryBits).fill(null);
    const groupMax = new Int8Array(1 << primaryBits);
    let hasLong = false;
    for (let sym = 0; sym < lengths.length; sym++) {
      const len = lengths[sym];
      if (len === 0 || len <= primaryBits) continue;
      hasLong = true;
      const prefix = reversed[sym] & ((1 << primaryBits) - 1);
      if (!groupLists[prefix]) groupLists[prefix] = [];
      groupLists[prefix]!.push(sym);
      if (len > groupMax[prefix]) groupMax[prefix] = len;
    }

    // 精确的短/长码前缀冲突检测：长码 L 的前 primaryBits 位前缀为 P，
    // 存在短码 S（len<=primaryBits）当且仅当 P 的低 len(S) 位 == rev(S)
    // 时 S 是 L 的前缀（冲突）。
    for (let p = 0; p < groupLists.length; p++) {
      if (!groupLists[p]) continue;
      for (let s = 0; s < lengths.length; s++) {
        const slen = lengths[s];
        if (slen === 0 || slen > primaryBits) continue;
        if ((p & ((1 << slen) - 1)) === reversed[s]) {
          throw new Error('invalid Huffman code: prefix conflict');
        }
      }
    }

    // 填主表短码（len <= primaryBits），位扩展。
    for (let sym = 0; sym < lengths.length; sym++) {
      const len = lengths[sym];
      if (len === 0 || len > primaryBits) continue;
      const rev = reversed[sym];
      const fill = 1 << (primaryBits - len);
      const step = 1 << len;
      for (let k = 0; k < fill; k++) this.table[rev + k * step] = sym;
    }

    if (!hasLong) return;

    for (let prefix = 0; prefix < this.table.length; prefix++) {
      const syms = groupLists[prefix];
      if (!syms) continue; // 只有短码或非法
      const subBits = groupMax[prefix] - primaryBits;
      const sub: SubTable = { bits: subBits, table: new Int32Array(1 << subBits).fill(-1) };
      const idx = this.subs.length;
      this.subs.push(sub);
      this.table[prefix] = -(idx + 2); // -2.. 标记子表，-1 保留给非法码
      // 子表索引是 peek>>>primaryBits 的低 subBits 位，对应反转码的
      // 第 primaryBits..len-1 位，即 (rev >>> primaryBits)。
      for (const sym of syms) {
        const len = lengths[sym];
        const tailBits = len - primaryBits;
        const tail = reversed[sym] >>> primaryBits;
        const fill = 1 << (subBits - tailBits);
        const step = 1 << tailBits;
        for (let k = 0; k < fill; k++) sub.table[tail + k * step] = sym;
      }
    }
  }

  /**
   * 从 peekBits（至少 maxLen 位的整数，低位为后续位流）解一个符号。
   * 返回符号；调用方负责 drop 对应的码长。
   */
  decode(peekBits: number): number {
    const v = this.table[peekBits & ((1 << this.primaryBits) - 1)];
    if (v >= 0) return v;
    if (v === -1) throw new Error('invalid Huffman code in stream');
    const sub = this.subs[-v - 2];
    const s = sub.table[(peekBits >>> this.primaryBits) & ((1 << sub.bits) - 1)];
    if (s === -1) throw new Error('invalid Huffman code in stream');
    return s;
  }
}

/** 固定 Huffman 块的字面量/长度码长（RFC 1951 §3.2.6）。 */
export function fixedLitLengths(): Uint8Array {
  const lengths = new Uint8Array(288);
  for (let i = 0; i <= 143; i++) lengths[i] = 8;
  for (let i = 144; i <= 255; i++) lengths[i] = 9;
  for (let i = 256; i <= 279; i++) lengths[i] = 7;
  for (let i = 280; i <= 287; i++) lengths[i] = 8;
  return lengths;
}

/** 固定 Huffman 块的距离码长：32 个符号全为 5 位。 */
export function fixedDistLengths(): Uint8Array {
  return new Uint8Array(32).fill(5);
}

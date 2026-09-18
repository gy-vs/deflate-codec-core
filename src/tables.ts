/**
 * RFC 1951 DEFLATE 用到的常量码表。
 * 长度码（257..285）与距离码（0..29）的基值和附加比特数，
 * 全部取自 RFC 1951 §3.2.5。
 */

/** 长度码：基数，索引为 code - 257。 */
export const LENGTH_BASE: readonly number[] = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];

/** 长度码：附加比特数，索引为 code - 257。 */
export const LENGTH_EXTRA: readonly number[] = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];

/** 距离码：基数，索引为 code。 */
export const DIST_BASE: readonly number[] = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289,
  16385, 24577,
];

/** 距离码：附加比特数，索引为 code。 */
export const DIST_EXTRA: readonly number[] = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];

/** DEFLATE 滑动窗口大小。 */
export const MAX_WBITS = 32768;
/** LZ77 允许的最大匹配长度。 */
export const MAX_MATCH = 258;
/** 最小匹配长度。 */
export const MIN_MATCH = 3;
/** 非压缩块单块最大字节数。STORED 块 LEN 字段为 16 位。 */
export const MAX_STORED = 65535;

/** 块内符号数上限，超过就收尾换块（同时保证 rawBytes < 65535）。 */
export const BLOCK_MAX_SYMBOLS = 15000;
/** 块内原始字节数的安全上限（严格小于 65535，保证 STORED 块合法）。 */
export const BLOCK_MAX_BYTES = 60000;

/** 动态块描述码长表时使用的符号排列顺序（RFC 1951 §3.2.7）。 */
export const CL_ORDER: readonly number[] = [
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
];

export const NUM_LIT_CODES = 286; // 字面量/长度字母表大小
export const NUM_DIST_CODES = 30; // 距离字母表大小
export const NUM_CL_CODES = 19; // 码长字母表大小
export const END_OF_BLOCK = 256;
export const MAX_CODE_LEN = 15;

/** 用常量表把匹配长度（3..258）映射到长度码（257..285）。 */
export function lengthCode(length: number): number {
  for (let i = 0; i < LENGTH_BASE.length - 1; i++) {
    if (length < LENGTH_BASE[i + 1]) return 257 + i;
  }
  return 285; // 258
}

let distLookup: Uint16Array | null = null;

/**
 * 距离（1..32768）到距离码（0..29）的反向查表。
 * 表为惰性构造，32769 个 Uint16 约 64KB。
 */
export function distanceCode(dist: number): number {
  if (!distLookup) {
    const table = new Uint16Array(MAX_WBITS + 1);
    for (let code = 0; code < DIST_BASE.length; code++) {
      const base = DIST_BASE[code];
      const span = 1 << DIST_EXTRA[code];
      const end = Math.min(base + span, MAX_WBITS + 1);
      for (let d = base; d < end; d++) table[d] = code;
    }
    distLookup = table;
  }
  return distLookup[dist];
}

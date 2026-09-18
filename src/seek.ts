/**
 * 可跳转 gzip：索引表示与按原始偏移区间的部分解压。
 *
 * 索引记录每个跳转点（跨度起点）对应的：
 *   rawOffset —— 该跨度第一个原始字节在原文件中的偏移
 *   bitOffset —— 该跨度第一个 DEFLATE 块的第一个位在
 *                DEFLATE 流（跳过 gzip 头之后）中的位偏移
 * 另外记录 DEFLATE 流结束位和原始总长度。
 *
 * 给定 [start, end) 原始偏移区间：二分找到起点所在跨度，
 * 从 entry[i].bitOffset 起跳逐跨度解码（跨度内无跨边界匹配，
 * 可独立解压），解到跨度末尾的块边界即停，再拼接切片。
 */

import { BitReader } from './bitstream';
import { GzipDeflater } from './gzip';
import { Inflater } from './inflate';
import { SeekEntry } from './deflate';

/** 我们产出的 gzip 使用固定 10 字节基本头，DEFLATE 从偏移 10 开始。 */
export const GZIP_DEFLATE_OFFSET = 10;

export interface SeekIndex {
  /** 跳转点，按 rawOffset 升序，首项必为 {0, 0}。 */
  entries: SeekEntry[];
  /** DEFLATE 流（gzip 头之后）的结束位偏移。 */
  endBitOffset: number;
  /** 原始数据总字节数。 */
  rawSize: number;
}

export interface IndexedGzip {
  data: Uint8Array;
  index: SeekIndex;
}

/** 带跳转索引的 gzip 压缩。interval 为跨度间隔（原始字节数），Infinity 表示不设跳转点。 */
export function gzipSyncIndexed(input: Uint8Array, interval: number): IndexedGzip {
  const opts = interval === Infinity ? {} : { seekInterval: interval };
  const g = new GzipDeflater(opts);
  g.write(input);
  const data = g.finish();
  const rawIndex = g.seekIndex;

  const raw = g.seekIndex;

  if (interval === Infinity) {
    // 不设跳转点：合成一个仅含整段范围的索引，仍可用于区间解压
    const index: SeekIndex = {
      entries: [{ rawOffset: 0, bitOffset: 0 }],
      endBitOffset: raw.length ? raw[raw.length - 1].bitOffset : 0,
      rawSize: input.length,
    };
    return { data, index };
  }

  // g.seekIndex：首项 {0,0}，之后每个真实跨度起点一个，末尾一个结束点
  // {rawSize, endBit}。恰在边界结束时，最后一个跨度起点与结束点
  // rawOffset 相同（位偏移也相同）。
  const end = raw[raw.length - 1];
  const spanStarts = raw.slice(0, -1);
  const last = spanStarts[spanStarts.length - 1];
  const entries =
    last && last.rawOffset === end.rawOffset ? spanStarts : spanStarts.concat([end]);
  const index: SeekIndex = {
    entries,
    endBitOffset: end.bitOffset,
    rawSize: input.length,
  };
  return { data, index };
}

export function serializeIndex(index: SeekIndex): string {
  return JSON.stringify(index);
}

export function parseIndex(text: string): SeekIndex {
  const idx = JSON.parse(text) as SeekIndex;
  if (!Array.isArray(idx.entries) || idx.entries.length === 0) {
    throw new Error('invalid seek index: missing entries');
  }
  if (typeof idx.endBitOffset !== 'number' || typeof idx.rawSize !== 'number') {
    throw new Error('invalid seek index: missing endBitOffset/rawSize');
  }
  return idx;
}

/** 支持随机范围读取的数据源（对象存储 SDK 包一层即可适配）。 */
export interface RandomAccessReader {
  size(): number | Promise<number>;
  read(offset: number, length: number): Uint8Array | Promise<Uint8Array>;
}

/** 找覆盖 rawOffset 的跨度索引 i（entry[i].rawOffset <= rawOffset）。 */
export function findSpan(index: SeekIndex, rawOffset: number): number {
  const e = index.entries;
  let lo = 0;
  let hi = e.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (e[mid].rawOffset <= rawOffset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function validateRange(index: SeekIndex, start: number, end: number): void {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    throw new Error('invalid range');
  }
  if (end > index.rawSize) {
    throw new Error(`range end ${end} exceeds raw size ${index.rawSize}`);
  }
}

/**
 * 解码一个完整跨度：region 从该跨度块的第一个字节开始（相对整个 gzip
 * 文件定位后再切片得到），intraByteBits 为块头在该字节内的位偏移，
 * spanRawBytes 为该跨度应产出的原始字节数。产出恰在块边界停止。
 */
function inflateSpan(
  region: Uint8Array,
  intraByteBits: number,
  spanRawBytes: number,
): Uint8Array {
  const reader = new BitReader(region, 0, region.length);
  reader.skipBits(intraByteBits);
  const inflater = new Inflater(reader, spanRawBytes);
  return inflater.run();
}

function concatParts(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * 解码覆盖 [start,end) 的若干连续跨度。
 * seg 是从 gzip 文件 segFileOffset 处开始的一段字节（至少覆盖这些跨度的
 * 压缩数据）；返回从第一个跨度起点 rawOffset 开始的原始字节。
 */
function inflateCoveringSpans(
  seg: Uint8Array,
  segFileOffset: number,
  index: SeekIndex,
  firstSpanIdx: number,
  start: number,
  end: number,
): Uint8Array {
  const entries = index.entries;
  const startRaw = entries[firstSpanIdx].rawOffset;

  let lastIdx = firstSpanIdx;
  while (lastIdx + 1 < entries.length && entries[lastIdx + 1].rawOffset < end) {
    lastIdx++;
  }

  const parts: Uint8Array[] = [];
  for (let i = firstSpanIdx; i <= lastIdx; i++) {
    const spanStartRaw = entries[i].rawOffset;
    const nextRaw = entries[i + 1] ? entries[i + 1].rawOffset : index.rawSize;
    const spanBytes = nextRaw - spanStartRaw;
    const bitOffset = entries[i].bitOffset;
    const byteOffset = GZIP_DEFLATE_OFFSET + (bitOffset >>> 3);
    const region = seg.subarray(byteOffset - segFileOffset);
    parts.push(inflateSpan(region, bitOffset & 7, spanBytes));
  }

  const merged = concatParts(parts);
  return merged.subarray(start - startRaw, end - startRaw);
}

/** 同步按区间解压，返回覆盖 [start, end) 的原始字节，长度恰为 end-start。 */
export function gunzipRangeSync(
  compressed: Uint8Array,
  index: SeekIndex,
  start: number,
  end: number,
): Uint8Array {
  validateRange(index, start, end);
  const i = findSpan(index, start);
  return inflateCoveringSpans(compressed, 0, index, i, start, end);
}

/** 计算覆盖 [start,end) 的跨度所对应的 gzip 文件字节区间 [lo, hi)。 */
export function coveringByteRange(
  index: SeekIndex,
  start: number,
  end: number,
): { lo: number; hi: number } {
  const i = findSpan(index, start);
  let lastIdx = i;
  while (lastIdx + 1 < index.entries.length && index.entries[lastIdx + 1].rawOffset < end) {
    lastIdx++;
  }
  const lo = GZIP_DEFLATE_OFFSET + (index.entries[i].bitOffset >>> 3);
  // 结束位：下一个跨度起点（或流结束点）。向上取整并多取 1 字节保险。
  const endBit = index.entries[lastIdx + 1]
    ? index.entries[lastIdx + 1].bitOffset
    : index.endBitOffset;
  const hi = GZIP_DEFLATE_OFFSET + ((endBit + 7) >>> 3) + 1;
  return { lo, hi };
}

/**
 * 异步按区间解压（对象存储等随机访问源）。
 * 只发起一次 Range 读取，拉取覆盖目标区间跨度的连续压缩字节段，
 * 而非整个对象——这是把查询从“整文件下载”降到“少量字节”的关键。
 */
export async function gunzipRange(
  reader: RandomAccessReader,
  index: SeekIndex,
  start: number,
  end: number,
): Promise<Uint8Array> {
  validateRange(index, start, end);
  const i = findSpan(index, start);
  const { lo, hi } = coveringByteRange(index, start, end);
  const totalSize = await reader.size();
  const clampedHi = Math.min(hi, totalSize);
  const seg = await reader.read(lo, clampedHi - lo);
  return inflateCoveringSpans(seg, lo, index, i, start, end);
}

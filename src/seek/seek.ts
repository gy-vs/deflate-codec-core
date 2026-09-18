/**
 * Seekable / ranged decompression.
 *
 * During indexed compression the input is split into independent DEFLATE
 * blocks: each starts with an empty 32 KiB window (it never references bytes
 * before itself), so any block can be decoded alone from its recorded
 * compressed bit offset. Given an uncompressed byte range, this module decodes
 * only the blocks that overlap the range and returns exactly its bytes.
 */
import { BitReader } from '../util/bits.js';
import {
  ArraySink,
  inflateOneBlockFromReader,
} from '../deflate/inflate.js';
import type { SeekPoint } from '../deflate/deflate.js';

/** A seek index: ordered, non-overlapping independent-block records. */
export class SeekIndex {
  constructor(readonly points: readonly SeekPoint[]) {}
}

/** Greatest seek point with uncompressedOffset <= offset. */
export function findSeekPoint(points: readonly SeekPoint[], offset: number): SeekPoint {
  let lo = 0;
  let hi = points.length - 1;
  let answer = points[0];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].uncompressedOffset <= offset) {
      answer = points[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return answer;
}

/** Decode one independent DEFLATE block beginning at an arbitrary bit offset. */
export function inflateBlockAt(compressed: Uint8Array, bitOffset: number): Uint8Array {
  const byteOffset = bitOffset >> 3;
  const skipBits = bitOffset & 7;
  const br = new BitReader(compressed.subarray(byteOffset));
  if (skipBits) br.read(skipBits);
  const sink = new ArraySink();
  inflateOneBlockFromReader(br, sink);
  return sink.toUint8Array();
}

/**
 * Decompress the uncompressed half-open range [start, end) using only the
 * independent blocks that overlap it.
 */
export function inflateRange(
  compressed: Uint8Array,
  index: SeekIndex,
  start: number,
  end: number,
): Uint8Array {
  if (start < 0 || end < start) throw new Error('invalid range');
  const points = index.points;
  if (points.length === 0) throw new Error('empty seek index');
  if (start === end) return new Uint8Array(0);

  const last = points[points.length - 1];
  const totalLength = last.uncompressedOffset + last.uncompressedLength;
  const safeEnd = Math.min(end, totalLength);

  const parts: Uint8Array[] = [];
  let produced = 0;

  // Binary-search the first overlapping block, then walk forward.
  const first = findSeekPoint(points, start);
  let i = points.indexOf(first);
  while (i >= 0 && i < points.length && points[i].uncompressedOffset < safeEnd) {
    const point = points[i];
    const blockBytes = inflateBlockAt(compressed, point.compressedBitOffset);
    const blockStart = point.uncompressedOffset;
    const blockEnd = blockStart + blockBytes.length;

    const copyFrom = Math.max(start, blockStart) - blockStart;
    const copyTo = Math.min(safeEnd, blockEnd) - blockStart;
    if (copyTo > copyFrom) {
      parts.push(blockBytes.subarray(copyFrom, copyTo));
      produced += copyTo - copyFrom;
    }
    i++;
  }

  const out = new Uint8Array(produced);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}

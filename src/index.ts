/**
 * Public API for the seekable gzip/DEFLATE codec library.
 *
 * Four capability groups:
 *   - raw DEFLATE: deflate / inflate
 *   - gzip: gzip / gunzip (standard gzip wrapper, CRC-32, ISIZE)
 *   - indexed compression: deflateSeekable, returning a SeekIndex
 *   - ranged decompression: inflateRange from a compressed stream + index
 */
import { deflateRaw, type DeflateOptions, type SeekPoint } from './deflate/deflate.js';
import { inflateRaw } from './deflate/inflate.js';
import { buildGzip, buildGzipHeader, type GzipHeaderOptions } from './gzip/gzip.js';
import {
  SeekIndex,
  inflateRange as inflateRangeImpl,
  inflateBlockAt,
} from './seek/seek.js';

export { gunzip } from './gzip/gunzip.js';
export { inflateRaw } from './deflate/inflate.js';
export { SeekIndex } from './seek/seek.js';
export type { SeekPoint, DeflateOptions } from './deflate/deflate.js';

export interface CompressOptions extends DeflateOptions {
  /** Optional file name stored in the gzip FNAME header field. */
  fileName?: string;
  /** Modification time (Unix seconds) stored in the gzip header. */
  mtime?: number;
}

export interface SeekableCompressResult {
  /** Complete standard gzip member. */
  gzip: Uint8Array;
  /** The raw DEFLATE stream (the gzip body). */
  deflate: Uint8Array;
  /** Index mapping uncompressed offsets to compressed bit offsets. */
  index: SeekIndex;
}

/** Compress to a raw DEFLATE stream (no gzip wrapper). */
export function deflate(input: Uint8Array, options: DeflateOptions = {}): Uint8Array {
  return deflateRaw(input, options).data;
}

/** Compress to a standard gzip member readable by gunzip/zcat. */
export function gzip(input: Uint8Array, options: CompressOptions = {}): Uint8Array {
  const { data: deflateBytes } = deflateRaw(input, {
    level: options.level,
    seekInterval: options.seekInterval,
  });
  const headerOptions: GzipHeaderOptions = {
    fileName: options.fileName,
    mtime: options.mtime,
    extraFlags: options.level && options.level >= 9 ? 2 : (options.level === 1 ? 4 : 0),
  };
  return buildGzip(buildGzipHeader(headerOptions), deflateBytes, input);
}

/** Decompress a raw DEFLATE stream. */
export function inflate(input: Uint8Array): Uint8Array {
  return inflateRaw(input).output;
}

/**
 * Compress with forced, independently-decodable blocks at every
 * `seekInterval` uncompressed bytes. Returns a standard gzip file plus an index
 * that enables ranged decompression.
 */
export function compressSeekable(
  input: Uint8Array,
  seekInterval: number,
  options: CompressOptions = {},
): SeekableCompressResult {
  if (!Number.isInteger(seekInterval) || seekInterval <= 0) {
    throw new Error('seekInterval must be a positive integer');
  }
  const { data: deflateBytes, index: rawIndex } = deflateRaw(input, {
    level: options.level,
    seekInterval,
  });
  const headerOptions: GzipHeaderOptions = {
    fileName: options.fileName,
    mtime: options.mtime,
    extraFlags: options.level && options.level >= 9 ? 2 : (options.level === 1 ? 4 : 0),
  };
  const header = buildGzipHeader(headerOptions);
  const gz = buildGzip(header, deflateBytes, input);
  return { gzip: gz, deflate: deflateBytes, index: new SeekIndex(rawIndex) };
}

/**
 * Decompress an uncompressed byte range [start, end) from a seekable stream.
 * Only the independent blocks overlapping the range are decoded.
 */
export function inflateRange(
  deflate: Uint8Array,
  index: SeekIndex,
  start: number,
  end: number,
): Uint8Array {
  return inflateRangeImpl(deflate, index, start, end);
}

/** Decode a single independent block at a given compressed bit offset. */
export function inflateSeekBlock(deflate: Uint8Array, bitOffset: number): Uint8Array {
  return inflateBlockAt(deflate, bitOffset);
}

/** Serialize an index to a compact JSON-friendly plain object. */
export function serializeIndex(index: SeekIndex): unknown {
  return {
    version: 1,
    points: (index as unknown as { points: SeekPoint[] }).points.map((p) => ({
      uncompressedOffset: p.uncompressedOffset,
      compressedBitOffset: p.compressedBitOffset,
      uncompressedLength: p.uncompressedLength,
    })),
  };
}

/** Parse a serialized index back into a SeekIndex. */
export function deserializeIndex(value: unknown): SeekIndex {
  const obj = value as { version?: number; points?: SeekPoint[] };
  if (!obj || obj.version !== 1 || !Array.isArray(obj.points)) {
    throw new Error('invalid serialized index');
  }
  return new SeekIndex(obj.points);
}

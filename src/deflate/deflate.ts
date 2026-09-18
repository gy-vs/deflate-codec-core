/**
 * DEFLATE compression.
 *
 * Orchestrates LZ77 tokenization and block emission. Without a seek interval a
 * single (or size-capped) block stream is produced with the best block type per
 * chunk. With a seek interval, the matcher window is reset at every boundary so
 * each block is independently decodable, and an index of (uncompressed offset,
 * compressed bit offset) is returned.
 */
import { BitWriter } from '../util/bits.js';
import { LzMatcher, TokenBuffer, type MatchOptions } from './matcher.js';
import { writeSmallestBlock } from './blocks.js';

/**
 * Input bytes per emitted block when not seeking. Large enough that repeated
 * dynamic-block headers are negligible, small enough to bound the token buffer
 * and frequency-pass memory regardless of total file size.
 */
const NON_SEEK_SPAN = 262_144;

export interface DeflateOptions {
  /** Compression effort preset 1..9 (mirrors zlib's level semantics loosely). */
  level?: number;
  /**
   * Force a fresh block + reset the sliding window after this many original
   * bytes. Undefined means no seek points (window never reset except for size).
   */
  seekInterval?: number;
}

export interface SeekPoint {
  /** Uncompressed byte offset where this block starts. */
  uncompressedOffset: number;
  /** Bit offset of the block header in the compressed DEFLATE stream. */
  compressedBitOffset: number;
  /** Number of uncompressed bytes covered by this block. */
  uncompressedLength: number;
}

export interface DeflateResult {
  data: Uint8Array;
  index: SeekPoint[];
}

/** Map a level to matcher tuning. Level 6 targets zlib-comparable density. */
function optionsForLevel(level: number): MatchOptions {
  const l = Math.max(1, Math.min(9, level));
  const presets: MatchOptions[] = [
    // index 1..9
    { maxChain: 4, maxLazy: 0, minMatch: 3, niceLength: 8 },
    { maxChain: 8, maxLazy: 1, minMatch: 3, niceLength: 16 },
    { maxChain: 16, maxLazy: 2, minMatch: 3, niceLength: 32 },
    { maxChain: 32, maxLazy: 3, minMatch: 3, niceLength: 64 },
    { maxChain: 64, maxLazy: 4, minMatch: 3, niceLength: 128 },
    { maxChain: 128, maxLazy: 4, minMatch: 3, niceLength: 128 },
    { maxChain: 256, maxLazy: 5, minMatch: 3, niceLength: 160 },
    { maxChain: 512, maxLazy: 6, minMatch: 3, niceLength: 200 },
    { maxChain: 1024, maxLazy: 8, minMatch: 3, niceLength: 258 },
  ];
  return presets[l - 1];
}

/** Compress to a raw DEFLATE stream (no gzip/zlib wrapper). */
export function deflateRaw(input: Uint8Array, options: DeflateOptions = {}): DeflateResult {
  const level = options.level ?? 6;
  const seekInterval = options.seekInterval;
  const matcherOpts = optionsForLevel(level);
  const matcher = new LzMatcher(matcherOpts);
  const tokens = new TokenBuffer(4096);
  const w = new BitWriter();
  const index: SeekPoint[] = [];

  // Determine block boundaries. Seek blocks reset history; when not seeking we
  // still cap blocks at 65535 input bytes for stored fallback feasibility.
  const boundaries: number[] = [];
  if (seekInterval && seekInterval > 0) {
    for (let p = 0; p < input.length; p += seekInterval) boundaries.push(p);
    boundaries.push(input.length);
  } else {
    boundaries.push(0);
    boundaries.push(input.length);
  }

  let blockIndex = 0;
  for (let bi = 0; bi < boundaries.length - 1; bi++) {
    let segStart = boundaries[bi];
    const segEnd = boundaries[bi + 1];
    if (seekInterval && seekInterval > 0) {
      // Independent seekable block: empty history at segStart.
      matcher.reset();
    }
    // A segment may exceed the size we process in one token buffer. Huffman
    // blocks have no DEFLATE size limit, so for the non-seek path we use a large
    // span (fewer blocks => fewer repeated dynamic headers, better ratio) while
    // the matcher window/history continues across spans. Seekable segments are
    // emitted as a single independent block each.
    const HUFFMAN_SPAN = seekInterval && seekInterval > 0
      ? Number.MAX_SAFE_INTEGER
      : NON_SEEK_SPAN;
    let spanStart = segStart;
    while (spanStart < segEnd) {
      const spanEnd = Math.min(spanStart + HUFFMAN_SPAN, segEnd);
      const isFinal = spanEnd === input.length;
      const recordSeek = seekInterval && seekInterval > 0 && spanStart === segStart;

      matcher.tokenize(input, spanStart, spanEnd, tokens);

      const bitOffset = w.bitPosition;
      if (recordSeek) {
        index.push({
          uncompressedOffset: spanStart,
          compressedBitOffset: bitOffset,
          uncompressedLength: segEnd - segStart,
        });
      }

      writeSmallestBlock(w, input, spanStart, spanEnd, tokens, isFinal);
      blockIndex++;
      spanStart = spanEnd;
    }
  }

  // Empty input: emit a single empty final block.
  if (input.length === 0) {
    index.length = 0;
    index.push({ uncompressedOffset: 0, compressedBitOffset: 0, uncompressedLength: 0 });
    tokens.reset();
    writeSmallestBlock(w, input, 0, 0, tokens, true);
  }

  return { data: w.finish(), index };
}

/**
 * DEFLATE decompressor (RFC 1951).
 *
 * Accepts every legal block type — stored, fixed Huffman and dynamic Huffman —
 * and arbitrary non-byte-aligned block boundaries. The bit reader keeps the
 * stream packed between blocks; only stored blocks force byte alignment.
 *
 * Output is written into a caller-supplied growable sink so the same code path
 * serves whole-stream and ranged decompression.
 */
import { BitReader } from '../util/bits.js';
import { buildDecoderTable, type DecoderTable } from './huffman.js';
import {
  CODE_LENGTH_ORDER,
  DISTANCE_BASE,
  DISTANCE_EXTRA_BITS,
  LENGTH_BASE,
  LENGTH_EXTRA_BITS,
  MAX_MATCH_LENGTH,
  MAX_WINDOW_SIZE,
  fixedDistanceLengths,
  fixedLiteralLengths,
} from './tables.js';

/** Minimal output sink: push literals / runs, report length. */
export interface OutputSink {
  writeByte(byte: number): void;
  writeRun(distance: number, length: number): void;
  readonly length: number;
}

/** Sink backed by a plain growing byte array (whole-stream decompression). */
export class ArraySink implements OutputSink {
  private data: Uint8Array;
  private len = 0;

  constructor(initialCapacity = 64 * 1024) {
    this.data = new Uint8Array(initialCapacity);
  }

  private ensure(extra: number): void {
    if (this.len + extra <= this.data.length) return;
    let size = this.data.length;
    while (size < this.len + extra) size = size <= 1 ? 1024 : (size * 2);
    const next = new Uint8Array(size);
    next.set(this.data.subarray(0, this.len));
    this.data = next;
  }

  writeByte(byte: number): void {
    this.ensure(1);
    this.data[this.len++] = byte;
  }

  writeRun(distance: number, length: number): void {
    this.ensure(length);
    let src = this.len - distance;
    if (src < 0) throw new Error('distance points before start of stream');
    // Copy byte by byte because distance < length means overlapping output.
    for (let i = 0; i < length; i++) this.data[this.len++] = this.data[src++];
  }

  get length(): number {
    return this.len;
  }

  toUint8Array(): Uint8Array {
    return this.data.slice(0, this.len);
  }
}

/** Sink that forwards into a preallocated output window with a hard cap. */
export class WindowSink implements OutputSink {
  readonly data: Uint8Array;
  len = 0;
  constructor(capacity: number) {
    this.data = new Uint8Array(capacity);
  }
  writeByte(byte: number): void {
    if (this.len >= this.data.length) throw new Error('output window overflow');
    this.data[this.len++] = byte;
  }
  writeRun(distance: number, length: number): void {
    if (this.len + length > this.data.length) throw new Error('output window overflow');
    let src = this.len - distance;
    if (src < 0) throw new Error('invalid back-reference');
    for (let i = 0; i < length; i++) this.data[this.len++] = this.data[src++];
  }
  get length(): number {
    return this.len;
  }
}

interface BlockTables {
  lit: DecoderTable;
  dist: DecoderTable;
}

function readCodeLengths(br: BitReader, count: number, codeLengthTable: DecoderTable): Uint8Array {
  const lengths = new Uint8Array(count);
  let i = 0;
  while (i < count) {
    const sym = decodeSymbol(br, codeLengthTable);
    if (sym < 16) {
      lengths[i++] = sym;
    } else if (sym === 16) {
      const repeat = br.read(2) + 3;
      if (i === 0) throw new Error('code length 16 with no previous value');
      if (i + repeat > count) throw new Error('code length repeat overruns');
      const prev = lengths[i - 1];
      lengths.fill(prev, i, i + repeat);
      i += repeat;
    } else if (sym === 17) {
      const repeat = br.read(3) + 3;
      if (i + repeat > count) throw new Error('code length zero repeat overruns');
      i += repeat;
    } else if (sym === 18) {
      const repeat = br.read(7) + 11;
      if (i + repeat > count) throw new Error('code length zero long repeat overruns');
      i += repeat;
    } else {
      throw new Error('bad code-length symbol ' + sym);
    }
  }
  return lengths;
}

function decodeSymbol(br: BitReader, table: DecoderTable): number {
  const peeked = br.peek16();
  const window = peeked & ((1 << table.fastBits) - 1);
  const fast = table.lookup[window];
  if (fast >= 0) {
    br.consume(fast >>> 16);
    return fast & 0xffff;
  }
  // Long code: peel fastBits already inspected and compare bit by bit.
  let code = window;
  br.consume(table.fastBits);
  for (let got = table.fastBits + 1; got <= table.maxBits; got++) {
    code |= br.read(1) << (got - 1);
    for (const e of table.longCodes) {
      if (e.bits === got && e.reversed === code) return e.symbol;
    }
  }
  throw new Error('invalid Huffman code in stream');
}

function readDynamicTables(br: BitReader): BlockTables {
  const hlit = br.read(5) + 257;
  const hdist = br.read(5) + 1;
  const hclen = br.read(4) + 4;
  const codeLengthLengths = new Uint8Array(19);
  for (let i = 0; i < hclen; i++) {
    codeLengthLengths[CODE_LENGTH_ORDER[i]] = br.read(3);
  }
  const codeLengthTable = buildDecoderTable(codeLengthLengths);
  const litLengths = readCodeLengths(br, hlit, codeLengthTable);
  const distLengths = readCodeLengths(br, hdist, codeLengthTable);

  // A one-code distance alphabet is legal and transmitted with one zero code
  // length; build a 1-entry table by promoting it to length 1 for decoding.
  let usedDist = 0;
  for (const l of distLengths) if (l) usedDist++;
  let distTable: DecoderTable;
  if (usedDist === 0) {
    // All-zero distance lengths: no distance codes may appear in this block.
    distTable = buildDecoderTable(new Uint8Array(1));
  } else {
    distTable = buildDecoderTable(distLengths);
  }
  return { lit: buildDecoderTable(litLengths), dist: distTable };
}

const fixedTables: BlockTables = {
  lit: buildDecoderTable(fixedLiteralLengths()),
  dist: buildDecoderTable(fixedDistanceLengths()),
};

/** Decompress one complete DEFLATE (raw, no zlib/gzip wrapper) stream. */
export function inflateRaw(input: Uint8Array, sink?: OutputSink): { output: Uint8Array; sink: OutputSink } {
  const out = sink ?? new ArraySink();
  inflateRawInto(input, out);
  if (out instanceof ArraySink) return { output: out.toUint8Array(), sink: out };
  if (out instanceof WindowSink) return { output: out.data.subarray(0, out.len), sink: out };
  throw new Error('custom sink: use inflateRawInto to read output');
}

export function inflateRawInto(input: Uint8Array, out: OutputSink): void {
  inflateRawStream(input, out);
}

/**
 * Inflate a raw DEFLATE stream and return the number of input bytes consumed
 * (the final block is byte aligned; trailing bytes beyond the stream are
 * ignored). Used by container formats (gzip) to locate following metadata.
 */
export function inflateRawStream(input: Uint8Array, out: OutputSink): { bytesConsumed: number } {
  const br = new BitReader(input);
  let bfinal = 0;
  do {
    bfinal = br.read(1);
    const btype = br.read(2);
    if (btype === 0) {
      inflateStoredBlock(br, out);
    } else if (btype === 1) {
      inflateHuffmanBlock(br, fixedTables, out);
    } else if (btype === 2) {
      const tables = readDynamicTables(br);
      inflateHuffmanBlock(br, tables, out);
    } else {
      throw new Error('invalid DEFLATE block type 3');
    }
  } while (!bfinal);
  // The final block's EOB is padded with zero bits to a byte boundary.
  br.alignToByte();
  return { bytesConsumed: br.bytePosition };
}

/**
 * Decode exactly one DEFLATE block from an already-positioned BitReader,
 * ignoring the block's BFINAL flag. This is the building block for ranged
 * decompression, where an indexed (window-reset) block is decoded on its own
 * even though it was not the final block of the original stream. Returns
 * whether the block had BFINAL set.
 */
export function inflateOneBlockFromReader(br: BitReader, out: OutputSink): boolean {
  const bfinal = br.read(1);
  const btype = br.read(2);
  if (btype === 0) {
    inflateStoredBlock(br, out);
  } else if (btype === 1) {
    inflateHuffmanBlock(br, fixedTables, out);
  } else if (btype === 2) {
    const tables = readDynamicTables(br);
    inflateHuffmanBlock(br, tables, out);
  } else {
    throw new Error('invalid DEFLATE block type 3');
  }
  return bfinal === 1;
}

function inflateStoredBlock(br: BitReader, out: OutputSink): void {
  br.alignToByte();
  const len = br.readByte() | (br.readByte() << 8);
  const nlen = br.readByte() | (br.readByte() << 8);
  if ((len ^ 0xffff) !== nlen) throw new Error('stored block LEN/NLEN mismatch');
  for (let i = 0; i < len; i++) out.writeByte(br.readByte());
}

function inflateHuffmanBlock(br: BitReader, tables: BlockTables, out: OutputSink): void {
  const { lit, dist } = tables;
  while (true) {
    const sym = decodeSymbol(br, lit);
    if (sym < 256) {
      out.writeByte(sym);
    } else if (sym === 256) {
      return;
    } else {
      const li = sym - 257;
      if (li >= LENGTH_BASE.length) throw new Error('invalid length symbol ' + sym);
      const length = LENGTH_BASE[li] + br.read(LENGTH_EXTRA_BITS[li]);
      if (length < 3 || length > MAX_MATCH_LENGTH) throw new Error('invalid match length');
      const distSym = decodeSymbol(br, dist);
      if (distSym >= DISTANCE_BASE.length) throw new Error('invalid distance symbol');
      const distance = DISTANCE_BASE[distSym] + br.read(DISTANCE_EXTRA_BITS[distSym]);
      if (distance > out.length || distance > MAX_WINDOW_SIZE) {
        throw new Error('back-reference distance ' + distance + ' out of range');
      }
      out.writeRun(distance, length);
    }
  }
}

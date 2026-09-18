/**
 * DEFLATE block encoding.
 *
 * Given LZ77 tokens, emits stored, fixed-Huffman or dynamic-Huffman blocks and
 * picks the smallest legal representation. Dynamic blocks build length-limited
 * Huffman codes for the literal/length and distance alphabets and serialize the
 * code lengths using the repeat symbols 16/17/18.
 */
import { BitWriter } from '../util/bits.js';
import { buildHuffman, validateLengths, type HuffmanCode } from './huffman.js';
import { codeLengthsFromFrequencies } from './bitlen.js';
import type { TokenBuffer } from './matcher.js';
import {
  CODE_LENGTH_ORDER,
  DISTANCE_BASE,
  DISTANCE_EXTRA_BITS,
  END_OF_BLOCK,
  LENGTH_BASE,
  LENGTH_EXTRA_BITS,
  lengthSymbol,
  distanceSymbol,
  fixedDistanceLengths,
  fixedLiteralLengths,
} from './tables.js';

const NUM_LIT_SYMBOLS = 286;
const NUM_DIST_SYMBOLS = 30;
export const MAX_STORED_BLOCK = 65535;

export interface Frequencies {
  lit: Uint32Array;
  dist: Uint32Array;
}

export function countFrequencies(tokens: TokenBuffer): Frequencies {
  const lit = new Uint32Array(288);
  const dist = new Uint32Array(30);
  lit[END_OF_BLOCK] = 1;
  for (let i = 0; i < tokens.count; i++) {
    if (!tokens.isMatch(i)) lit[tokens.literal(i)]++;
    else {
      lit[lengthSymbol(tokens.matchLength(i))]++;
      dist[distanceSymbol(tokens.matchDistance(i))]++;
    }
  }
  return { lit, dist };
}

interface CodeSet {
  litLengths: Uint8Array;
  distLengths: Uint8Array;
  litHuff: HuffmanCode;
  distHuff: HuffmanCode;
  distUsed: boolean;
}

function buildCodes(freq: Frequencies): CodeSet {
  const litLengths = new Uint8Array(288);
  const distLengths = new Uint8Array(30);
  codeLengthsFromFrequencies(freq.lit, NUM_LIT_SYMBOLS, litLengths);
  if (litLengths[END_OF_BLOCK] === 0) litLengths[END_OF_BLOCK] = 1;
  validateLengths(litLengths);

  let distUsed = false;
  for (let i = 0; i < NUM_DIST_SYMBOLS; i++) {
    if (freq.dist[i] > 0) { distUsed = true; break; }
  }
  if (distUsed) {
    codeLengthsFromFrequencies(freq.dist, NUM_DIST_SYMBOLS, distLengths);
    validateLengths(distLengths);
  }
  return {
    litLengths,
    distLengths,
    litHuff: buildHuffman(litLengths),
    distHuff: buildHuffman(distUsed ? distLengths : new Uint8Array(1)),
    distUsed,
  };
}

function trimLengths(lengths: Uint8Array, minimum: number): number {
  let n = lengths.length;
  while (n > minimum && lengths[n - 1] === 0) n--;
  return n;
}

/**
 * Compress a code-length sequence with symbols 0..18 (RFC 1951 3.2.7).
 * Greedy run encoding:
 *  - zero runs of 3..10 -> symbol 17, 11..138 -> symbol 18 (split if longer)
 *  - nonzero value: emit it, then repeat 3..6 more times with symbol 16
 */
export function encodeCodeLengths(seq: readonly number[]): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < seq.length) {
    // Count the maximal run of the identical value seq[i].
    const v = seq[i];
    let run = 1;
    while (i + run < seq.length && seq[i + run] === v) run++;

    if (v === 0) {
      let remaining = run;
      while (remaining >= 11) {
        const take = Math.min(138, remaining);
        out.push(18, take - 11); // 11..138 zeros
        remaining -= take;
      }
      if (remaining >= 3) {
        out.push(17, remaining - 3); // 3..10 zeros
      } else {
        while (remaining-- > 0) out.push(0);
      }
    } else {
      // Emit the first occurrence literally.
      out.push(v);
      let covered = 1;
      // Pack additional identical lengths with 16 (3..6 per symbol).
      while (run - covered >= 3) {
        const repeat = Math.min(6, run - covered);
        out.push(16, repeat - 3);
        covered += repeat;
      }
      // Emit any leftover (< 3 trailing copies) literally.
      while (covered < run) {
        out.push(v);
        covered++;
      }
    }
    i += run;
  }
  return out;
}

function emitClSequence(w: BitWriter, clSymbols: readonly number[], clLengths: Uint8Array, clHuff: HuffmanCode): void {
  for (let i = 0; i < clSymbols.length; i++) {
    const s = clSymbols[i];
    w.write(clHuff.codes[s], clLengths[s]);
    if (s === 16) w.write(clSymbols[++i], 2);
    else if (s === 17) w.write(clSymbols[++i], 3);
    else if (s === 18) w.write(clSymbols[++i], 7);
  }
}

function writeDynamicHeader(w: BitWriter, codes: CodeSet): void {
  const hlit = Math.max(257, trimLengths(codes.litLengths, 257));
  const hdist = codes.distUsed ? trimLengths(codes.distLengths, 1) : 0;
  const distTransmit = hdist === 0 ? 1 : hdist;

  const seq: number[] = [];
  for (let i = 0; i < hlit; i++) seq.push(codes.litLengths[i]);
  for (let i = 0; i < distTransmit; i++) seq.push(hdist === 0 ? 0 : codes.distLengths[i]);
  const clSymbols = encodeCodeLengths(seq);

  const clFreq = new Uint32Array(19);
  for (const s of clSymbols) {
    if (s < 16) clFreq[s]++;
    // 16/17/18 each contribute one code-length symbol too.
    else clFreq[s]++;
  }
  const clLengths = new Uint8Array(19);
  codeLengthsFromFrequencies(clFreq, 19, clLengths);
  validateLengths(clLengths);
  const clHuff = buildHuffman(clLengths);

  let hclenCount = 4;
  for (let i = 0; i < 19; i++) {
    if (clLengths[CODE_LENGTH_ORDER[i]] !== 0) hclenCount = i + 1;
  }

  w.write(hlit - 257, 5);
  w.write(distTransmit - 1, 5);
  w.write(hclenCount - 4, 4);
  for (let i = 0; i < hclenCount; i++) w.write(clLengths[CODE_LENGTH_ORDER[i]], 3);
  emitClSequence(w, clSymbols, clLengths, clHuff);
}

function emitTokens(w: BitWriter, tokens: TokenBuffer, litHuff: HuffmanCode, litLengths: Uint8Array, distHuff: HuffmanCode, distLengths: Uint8Array): void {
  for (let i = 0; i < tokens.count; i++) {
    if (!tokens.isMatch(i)) {
      const v = tokens.literal(i);
      w.write(litHuff.codes[v], litLengths[v]);
    } else {
      const length = tokens.matchLength(i);
      const distance = tokens.matchDistance(i);
      const ls = lengthSymbol(length);
      w.write(litHuff.codes[ls], litLengths[ls]);
      const li = ls - 257;
      if (LENGTH_EXTRA_BITS[li] > 0) {
        w.write(length - LENGTH_BASE[li], LENGTH_EXTRA_BITS[li]);
      }
      const ds = distanceSymbol(distance);
      w.write(distHuff.codes[ds], distLengths[ds]);
      if (DISTANCE_EXTRA_BITS[ds] > 0) {
        w.write(distance - DISTANCE_BASE[ds], DISTANCE_EXTRA_BITS[ds]);
      }
    }
  }
  w.write(litHuff.codes[END_OF_BLOCK], litLengths[END_OF_BLOCK]);
}

function writeFixedBlock(w: BitWriter, tokens: TokenBuffer, final: boolean): void {
  w.write(final ? 1 : 0, 1);
  w.write(1, 2);
  const litLengths = fixedLiteralLengths();
  const distLengths = fixedDistanceLengths();
  const litHuff = buildHuffman(litLengths);
  const distHuff = buildHuffman(distLengths);
  emitTokens(w, tokens, litHuff, litLengths, distHuff, distLengths);
}

function writeDynamicBlock(w: BitWriter, tokens: TokenBuffer, final: boolean): void {
  w.write(final ? 1 : 0, 1);
  w.write(2, 2);
  const codes = buildCodes(countFrequencies(tokens));
  writeDynamicHeader(w, codes);
  emitTokens(w, tokens, codes.litHuff, codes.litLengths, codes.distHuff, codes.distUsed ? codes.distLengths : new Uint8Array(30));
}

function writeStoredBlock(w: BitWriter, data: Uint8Array, start: number, len: number, final: boolean): void {
  w.write(final ? 1 : 0, 1);
  w.write(0, 2);
  w.alignToByte();
  w.write(len & 0xff, 8);
  w.write((len >> 8) & 0xff, 8);
  w.write((~len) & 0xff, 8);
  w.write(((~len) >> 8) & 0xff, 8);
  w.writeBytes(data.subarray(start, start + len));
}

/**
 * Emit the smallest of stored / fixed / dynamic for one span.
 * Stored cost assumes the stream is byte aligned at the block boundary (true
 * for the first block; for later Huffman blocks the real alignment padding is
 * at most 7 bits, which we add as a correction).
 */
export function writeSmallestBlock(
  w: BitWriter,
  input: Uint8Array,
  start: number,
  end: number,
  tokens: TokenBuffer,
  final: boolean,
): void {
  const len = end - start;

  // Cost candidates in bits.
  const fixedBits = blockBitsFixed(tokens);
  const dynamicCodes = buildCodes(countFrequencies(tokens));
  const dynamicBits = blockBitsDynamic(tokens, dynamicCodes);

  let storedBits = Number.POSITIVE_INFINITY;
  if (len > 0 && len <= MAX_STORED_BLOCK) {
    const align = (8 - (w.bitPosition & 7)) & 7;
    storedBits = align + 40 + len * 8;
  }

  if (storedBits <= fixedBits && storedBits <= dynamicBits && len > 0) {
    writeStoredBlock(w, input, start, len, final);
  } else if (dynamicBits <= fixedBits) {
    writeDynamicBlock(w, tokens, final);
  } else {
    writeFixedBlock(w, tokens, final);
  }
}

function blockBitsFixed(tokens: TokenBuffer): number {
  const litLen = fixedLiteralLengths();
  const distLen = fixedDistanceLengths();
  return 3 + tokenBits(tokens, litLen, distLen);
}

export function writeBestHuffmanBlock(w: BitWriter, tokens: TokenBuffer, final: boolean): void {
  const fixedBits = blockBitsFixed(tokens);
  const dynamicCodes = buildCodes(countFrequencies(tokens));
  const dynamicBits = blockBitsDynamic(tokens, dynamicCodes);
  if (dynamicBits <= fixedBits) writeDynamicBlock(w, tokens, final);
  else writeFixedBlock(w, tokens, final);
}

function tokenBits(tokens: TokenBuffer, litLen: Uint8Array, distLen: Uint8Array): number {
  let bits = 0;
  for (let i = 0; i < tokens.count; i++) {
    if (!tokens.isMatch(i)) {
      bits += litLen[tokens.literal(i)];
    } else {
      const ls = lengthSymbol(tokens.matchLength(i));
      bits += litLen[ls] + LENGTH_EXTRA_BITS[ls - 257];
      const ds = distanceSymbol(tokens.matchDistance(i));
      bits += distLen[ds] + DISTANCE_EXTRA_BITS[ds];
    }
  }
  bits += litLen[END_OF_BLOCK];
  return bits;
}

function blockBitsDynamic(tokens: TokenBuffer, codes: CodeSet): number {
  const hlit = Math.max(257, trimLengths(codes.litLengths, 257));
  const hdist = codes.distUsed ? trimLengths(codes.distLengths, 1) : 0;
  const distTransmit = hdist === 0 ? 1 : hdist;
  const seq: number[] = [];
  for (let i = 0; i < hlit; i++) seq.push(codes.litLengths[i]);
  for (let i = 0; i < distTransmit; i++) seq.push(hdist === 0 ? 0 : codes.distLengths[i]);
  const clSymbols = encodeCodeLengths(seq);
  const clFreq = new Uint32Array(19);
  for (const s of clSymbols) clFreq[s]++;
  const clLengths = new Uint8Array(19);
  codeLengthsFromFrequencies(clFreq, 19, clLengths);
  const clHuff = buildHuffman(clLengths);
  let hclenCount = 4;
  for (let i = 0; i < 19; i++) if (clLengths[CODE_LENGTH_ORDER[i]] !== 0) hclenCount = i + 1;

  let bits = 3 + 5 + 5 + 4 + 3 * hclenCount;
  for (let i = 0; i < clSymbols.length; i++) {
    const s = clSymbols[i];
    bits += clLengths[s];
    if (s === 16) { bits += 2; i++; }
    else if (s === 17) { bits += 3; i++; }
    else if (s === 18) { bits += 7; i++; }
  }
  void clHuff;
  bits += tokenBits(tokens, codes.litLengths, codes.distUsed ? codes.distLengths : new Uint8Array(30));
  return bits;
}

export { writeStoredBlock, writeDynamicBlock, writeFixedBlock, buildCodes };

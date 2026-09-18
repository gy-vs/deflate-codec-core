/**
 * DEFLATE (RFC 1951) length and distance code tables.
 *
 * The length/distance symbols encode (base, extraBits); the transmitted value
 * is base + extraBits(unsigned). The ranges are contiguous and jointly cover
 * match lengths 3..258 and distances 1..32768.
 *
 * These tables were cross-checked empirically against Node's zlib in
 * scratch/derive-tables.mjs (symbols observed on crafted single-match streams)
 * and are additionally covered by the round-trip tests in test/.
 */

export const LENGTH_MIN_SYMBOL = 257;
export const LENGTH_MAX_SYMBOL = 285;
export const END_OF_BLOCK = 256;

/** Extra-bit widths for length symbols 257..285 (index = symbol - 257). */
export const LENGTH_EXTRA_BITS = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
]);

/**
 * Base match lengths for symbols 257..285 (index = symbol - 257), per RFC 1951
 * section 3.2.5. Symbols 257..264 encode single lengths 3..10; subsequent
 * groups of four share an extra-bit width with bases stepping by 2,4,8,...,32;
 * symbol 285 is a singleton for the maximum length 258.
 */
export const LENGTH_BASE = new Uint16Array([
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
]);

/** Extra-bit widths for distance symbols 0..29. */
export const DISTANCE_EXTRA_BITS = new Uint8Array([
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
]);

/** Base distances for symbols 0..29. */
export const DISTANCE_BASE = new Uint16Array([
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289,
  16385, 24577,
]);

/** Maximum legal backward distance / sliding window size. */
export const MAX_WINDOW_SIZE = 32768;

/** Maximum legal match length. */
export const MAX_MATCH_LENGTH = 258;

/** Minimum match length that DEFLATE encodes as a length/distance pair. */
export const MIN_MATCH_LENGTH = 3;

/** Order in which code-length code lengths are transmitted. */
export const CODE_LENGTH_ORDER = new Uint8Array([
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
]);

/** Fixed-Huffman literal/length code lengths for symbols 0..287. */
export function fixedLiteralLengths(): Uint8Array {
  const lengths = new Uint8Array(288);
  lengths.fill(8, 0, 144);
  lengths.fill(9, 144, 256);
  lengths.fill(7, 256, 280);
  lengths.fill(8, 280, 288);
  return lengths;
}

/** Fixed-Huffman distance code lengths (all five bits). */
export function fixedDistanceLengths(): Uint8Array {
  return new Uint8Array(30).fill(5);
}

/**
 * Map a match length 3..258 to its length symbol. Two-entry lookup built once;
 * lengths outside the densely grouped middle region fall on exact base rows.
 */
const lengthSymbolByLength = buildLengthSymbolLookup();

function buildLengthSymbolLookup(): Uint16Array {
  // Find, for every length 3..258, the unique symbol whose [base, base+2^eb)
  // range contains it. Symbols reach 285, so 16-bit storage is required.
  const table = new Uint16Array(259);
  for (let sym = 257; sym <= 285; sym++) {
    const i = sym - 257;
    const base = LENGTH_BASE[i];
    if (base === 0) continue;
    const span = 1 << LENGTH_EXTRA_BITS[i];
    for (let v = base; v < base + span && v <= 258; v++) table[v] = sym;
  }
  return table;
}

export function lengthSymbol(length: number): number {
  return lengthSymbolByLength[length];
}

/** Map a distance 1..32768 to its distance symbol via a cached lookup table. */
const distanceSymbolByDistance = buildDistanceSymbolLookup();

function buildDistanceSymbolLookup(): Uint16Array {
  const table = new Uint16Array(32769);
  for (let sym = 0; sym < 30; sym++) {
    const base = DISTANCE_BASE[sym];
    const span = 1 << DISTANCE_EXTRA_BITS[sym];
    const end = Math.min(32768, base + span - 1);
    for (let d = base; d <= end; d++) table[d] = sym;
  }
  return table;
}

export function distanceSymbol(distance: number): number {
  return distanceSymbolByDistance[distance];
}

/**
 * Canonical Huffman coding for DEFLATE.
 *
 * DEFLATE transmits per-symbol code *lengths*; the actual codes are derived with
 * the canonical assignment (RFC 1951 section 3.2.2). On the wire codes are
 * packed least-significant bit first, so an encoder emits the canonical code
 * bit-reversed within its length; a decoder reads bits from the LSB side and
 * matches those reversed values.
 */

export interface HuffmanCode {
  /** Number of symbols (286/30/19 in practice). */
  readonly size: number;
  /** Code length per symbol (0 = symbol absent). */
  readonly lengths: Uint8Array;
  /** Bit-reversed canonical code per present symbol, -1 when absent. */
  readonly codes: Int32Array;
  /** Maximum code length. */
  readonly maxBits: number;
}

/** Reverse the low `bits` of `value`. */
export function reverseBits(value: number, bits: number): number {
  let r = 0;
  for (let i = 0; i < bits; i++) r = (r << 1) | ((value >>> i) & 1);
  return r >>> 0;
}

/** Build canonical (MSB-assigned) codes from lengths, then reverse for the wire. */
export function buildHuffman(lengths: Uint8Array): HuffmanCode {
  let maxBits = 0;
  for (let i = 0; i < lengths.length; i++) {
    const l = lengths[i];
    if (l > maxBits) maxBits = l;
    if (l > 15) throw new Error('Huffman code length exceeds 15 bits');
  }
  // blCount[b] = number of codes of length b
  const blCount = new Uint16Array(maxBits + 1);
  for (let i = 0; i < lengths.length; i++) {
    if (lengths[i]) blCount[lengths[i]]++;
  }
  // next_code per length, canonical assignment
  const nextCode = new Uint32Array(maxBits + 1);
  let code = 0;
  for (let bits = 1; bits <= maxBits; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  const codes = new Int32Array(lengths.length).fill(-1);
  for (let sym = 0; sym < lengths.length; sym++) {
    const len = lengths[sym];
    if (len) codes[sym] = reverseBits(nextCode[len]++, len);
  }
  return { size: lengths.length, lengths, codes, maxBits };
}

/**
 * Validate code lengths: reject only over-subscribed sets (Kraft sum > 1).
 * Incomplete sets (sum < 1) are legal in DEFLATE — the unused bit patterns
 * simply never appear in a conformant stream.
 */
export function validateLengths(lengths: Uint8Array): void {
  let maxBits = 0;
  for (let i = 0; i < lengths.length; i++) {
    const l = lengths[i];
    if (l > maxBits) maxBits = l;
  }
  if (maxBits === 0) return;
  if (maxBits > 15) throw new Error('code length too long');
  const blCount = new Uint16Array(maxBits + 1);
  for (let i = 0; i < lengths.length; i++) {
    if (lengths[i]) blCount[lengths[i]]++;
  }
  let left = 1;
  for (let bits = 1; bits <= maxBits; bits++) {
    left <<= 1;
    left -= blCount[bits];
    if (left < 0) throw new Error('over-subscribed Huffman codes');
  }
}

/**
 * Fast decoder table. A fixed-width window of FAST bits maps directly to a
 * symbol for codes no longer than FAST; longer codes are handled by a small
 * linear fallback (max DEFLATE code length is 15).
 */
export interface DecoderTable {
  readonly fastBits: number;
  /** FAST-bit lookup: packed symbol | (consumedBits << 16), or -1. */
  readonly lookup: Int32Array;
  readonly longCodes: ReadonlyArray<{ bits: number; reversed: number; symbol: number }>;
  readonly maxBits: number;
}

const FAST_BITS = 10;

export function buildDecoderTable(lengths: Uint8Array): DecoderTable {
  let maxBits = 0;
  for (const l of lengths) if (l > maxBits) maxBits = l;
  const fastBits = Math.min(maxBits || 1, FAST_BITS);
  const lookup = new Int32Array(1 << fastBits).fill(-1);
  const longCodes: { bits: number; reversed: number; symbol: number }[] = [];
  const huff = buildHuffman(lengths);
  for (let sym = 0; sym < lengths.length; sym++) {
    const bits = lengths[sym];
    if (!bits) continue;
    const reversed = huff.codes[sym];
    if (bits <= fastBits) {
      // The wire code occupies the low `bits` bits of the window; codes shorter
      // than FAST must match regardless of the following bits, so replicate
      // across all values of the leading (fastBits - bits) HIGH bits.
      const pad = 1 << (fastBits - bits);
      for (let high = 0; high < pad; high++) {
        lookup[reversed | (high << bits)] = sym | (bits << 16);
      }
    } else {
      longCodes.push({ bits, reversed, symbol: sym });
    }
  }
  return { fastBits, lookup, longCodes, maxBits };
}

/**
 * LZ77 sliding-window matcher.
 *
 * Emits literal / length-distance tokens over a 32 KiB window using a 3-byte
 * hash head plus hash chains (zlib's head[]/prev[] structure) with configurable
 * chain effort and lazy matching.
 *
 * Tokens are stored compactly in growable typed arrays (no per-token objects)
 * so multi-hundred-MB inputs stay memory bounded when processed in blocks.
 *
 * The matcher can be reset to forget all history, which indexed (seekable)
 * compression does at every seek point so a block is independently decodable.
 */
import {
  MAX_MATCH_LENGTH,
  MAX_WINDOW_SIZE,
  MIN_MATCH_LENGTH,
} from './tables.js';

/**
 * Compact token stream.
 *  - sym[i]: a literal byte (0..255) or a length symbol (257..285).
 *  - arg[i]: 0 for literals; for matches `length | (distance << 9)`
 *    (length needs 9 bits, distance 15 bits: 24 bits total).
 */
export class TokenBuffer {
  sym: Int32Array;
  arg: Int32Array;
  count = 0;

  constructor(capacity = 1024) {
    this.sym = new Int32Array(capacity);
    this.arg = new Int32Array(capacity);
  }

  private ensure(extra: number): void {
    if (this.count + extra <= this.sym.length) return;
    let size = this.sym.length;
    while (size < this.count + extra) size *= 2;
    const ns = new Int32Array(size);
    const na = new Int32Array(size);
    ns.set(this.sym);
    na.set(this.arg);
    this.sym = ns;
    this.arg = na;
  }

  pushLiteral(value: number): void {
    this.ensure(1);
    this.sym[this.count] = value;
    this.arg[this.count] = 0;
    this.count++;
  }

  pushMatch(length: number, distance: number): void {
    this.ensure(1);
    this.sym[this.count] = 0; // resolved to length symbol lazily by the block writer
    this.arg[this.count] = length | (distance << 9);
    this.count++;
  }

  isMatch(i: number): boolean {
    return this.arg[i] !== 0;
  }

  literal(i: number): number {
    return this.sym[i];
  }

  matchLength(i: number): number {
    return this.arg[i] & 0x1ff;
  }

  matchDistance(i: number): number {
    return this.arg[i] >>> 9;
  }

  reset(): void {
    this.count = 0;
  }
}

export interface MatchOptions {
  /** Max hash-chain links to follow (higher = better ratio, slower). */
  maxChain: number;
  /** Lazy-match lookahead depth (zlib uses 4 at level 6). */
  maxLazy: number;
  /** Matches shorter than this are treated as literals. */
  minMatch: number;
  /** Stop searching once a match of at least this length is found. */
  niceLength: number;
}

const HASH_BITS = 16;
const HASH_SIZE = 1 << HASH_BITS;
const HASH_MASK = HASH_SIZE - 1;
const WINDOW_MASK = MAX_WINDOW_SIZE - 1;

function hash3(a: number, b: number, c: number): number {
  return ((a << 10) ^ (b << 5) ^ c) & HASH_MASK;
}

export class LzMatcher {
  private head = new Int32Array(HASH_SIZE).fill(-1);
  private prev = new Int32Array(MAX_WINDOW_SIZE).fill(-1);
  private readonly opts: MatchOptions;

  constructor(opts: MatchOptions) {
    this.opts = opts;
  }

  /** Forget all history (begin an independent seekable block). */
  reset(): void {
    this.head.fill(-1);
    this.prev.fill(-1);
  }

  private insert(pos: number, data: Uint8Array, end: number): void {
    if (pos + MIN_MATCH_LENGTH <= end) {
      const h = hash3(data[pos], data[pos + 1], data[pos + 2]);
      this.prev[pos & WINDOW_MASK] = this.head[h];
      this.head[h] = pos;
    }
  }

  /** Longest match reachable from `pos` with length at least `minLen`. */
  private findMatch(pos: number, data: Uint8Array, end: number, minLen: number): { length: number; distance: number } | null {
    if (pos + MIN_MATCH_LENGTH > end) return null;
    const maxLen = Math.min(MAX_MATCH_LENGTH, end - pos);
    const h = hash3(data[pos], data[pos + 1], data[pos + 2]);
    let candidate = this.head[h];
    const windowStart = pos - MAX_WINDOW_SIZE;
    let bestLen = minLen - 1;
    let bestDist = 0;
    let chain = this.opts.maxChain;
    while (candidate < pos && candidate > windowStart && chain-- > 0) {
      if (bestLen >= maxLen) break;
      // Cheap reject on the byte one past the best match, then verify.
      if (data[candidate + bestLen] === data[pos + bestLen] &&
          data[candidate] === data[pos] &&
          data[candidate + 1] === data[pos + 1]) {
        let len = 2;
        while (len < maxLen && data[candidate + len] === data[pos + len]) len++;
        if (len > bestLen) {
          bestLen = len;
          bestDist = pos - candidate;
          if (len >= this.opts.niceLength || len >= maxLen) break;
        }
      }
      candidate = this.prev[candidate & WINDOW_MASK];
    }
    if (bestLen >= minLen) return { length: bestLen, distance: bestDist };
    return null;
  }

  /**
   * Tokenize data[start..end] into `out` (which is reset first). History before
   * `start` is whatever is currently in the window; callers reset() when the
   * block must be self-contained.
   */
  /**
   * Tokenize one span in a single forward pass with lazy matching.
   *
   * Standard zlib-style invariant: every input position is inserted into the
   * hash exactly once as the cursor passes it; positions consumed by a match
   * are inserted (cheaply) but not searched. Search happens only for positions
   * that can actually become a token, which keeps the cost linear in chain
   * work rather than input length.
   */
  tokenize(data: Uint8Array, start: number, end: number, out: TokenBuffer): void {
    out.reset();
    const { minMatch, maxLazy, niceLength } = this.opts;

    let pos = start;
    // Invariant at the top of the loop: positions [start, pos) are inserted,
    // position `pos` is NOT inserted (so findMatch can't match itself).
    let insertedUpTo = start - 1;
    const ensureInserted = (p: number): void => {
      while (insertedUpTo < p && insertedUpTo + 1 < end) {
        insertedUpTo++;
        this.insert(insertedUpTo, data, end);
      }
    };

    while (pos < end) {
      const found = this.findMatch(pos, data, end, minMatch);
      let len = found ? Math.min(found.length, end - pos) : 0;
      let dist = found ? found.distance : 0;

      if (len < minMatch) {
        out.pushLiteral(data[pos]);
        ensureInserted(pos);
        pos++;
        continue;
      }

      // Lazy matching: look ahead a few positions for a strictly longer match.
      let lazy = 0;
      while (lazy < maxLazy && len < niceLength && len < MAX_MATCH_LENGTH && pos + 1 < end) {
        ensureInserted(pos);
        const nextPos = pos + 1;
        const ahead = this.findMatch(nextPos, data, end, len + 1);
        if (!ahead || ahead.length <= len) break;
        out.pushLiteral(data[pos]);
        pos = nextPos;
        len = Math.min(ahead.length, end - pos);
        dist = ahead.distance;
        lazy++;
      }

      out.pushMatch(len, dist);
      // Insert all positions the match consumes (its start and interior).
      const stop = pos + len;
      ensureInserted(stop - 1);
      pos = stop;
    }
  }
}

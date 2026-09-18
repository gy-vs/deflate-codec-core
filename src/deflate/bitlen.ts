/**
 * Construct 15-bit-limited canonical Huffman code lengths from frequencies.
 *
 * Stage 1 builds an unrestricted Huffman tree with a binary min-heap.
 * Stage 2 caps depths at 15 and restores a valid Kraft distribution.
 *
 * DEFLATE alphabets are tiny (<= 286 literal and 30 distance symbols, far below
 * 2^15), so an unrestricted tree essentially never exceeds 15 bits; the cap is
 * a defensive correctness guarantee rather than a hot path.
 */

const MAX_BITS = 15;
const SENTINEL = 0xffff;

export function codeLengthsFromFrequencies(freq: Uint32Array, n: number, lengths: Uint8Array): number {
  const order: number[] = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) order.push(i);
  const count = order.length;
  if (count === 0) return 0;
  if (count === 1) {
    lengths[order[0]] = 1;
    return 1;
  }
  order.sort((a, b) => (freq[a] - freq[b]) || (a - b));

  const total = 2 * count - 1;
  const weight = new Uint32Array(total);
  const parent = new Int32Array(total).fill(-1);
  for (let i = 0; i < count; i++) weight[i] = freq[order[i]];

  // Binary min-heap over node indices.
  const heap: number[] = [];
  const less = (a: number, b: number): boolean =>
    weight[a] < weight[b] || (weight[a] === weight[b] && a < b);
  const push = (x: number): void => {
    heap.push(x);
    let i = heap.length - 1;
    while (i > 0) {
      const pi = (i - 1) >> 1;
      if (!less(heap[i], heap[pi])) break;
      [heap[i], heap[pi]] = [heap[pi], heap[i]];
      i = pi;
    }
  };
  const pop = (): number => {
    const top = heap[0];
    const last = heap.pop() as number;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let s = i;
        if (l < heap.length && less(heap[l], heap[s])) s = l;
        if (r < heap.length && less(heap[r], heap[s])) s = r;
        if (s === i) break;
        [heap[i], heap[s]] = [heap[s], heap[i]];
        i = s;
      }
    }
    return top;
  };

  for (let i = 0; i < count; i++) push(i);
  let nextInternal = count;
  for (let k = 0; k < count - 1; k++) {
    const a = pop();
    const b = pop();
    const node = nextInternal++;
    let sum = weight[a] + weight[b];
    if (sum >= SENTINEL) sum = SENTINEL - 1;
    weight[node] = sum;
    parent[a] = node;
    parent[b] = node;
    push(node);
  }
  const root = total - 1;

  const depth = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    let node = i;
    let d = 0;
    while (node !== root) {
      node = parent[node];
      d++;
    }
    depth[i] = d;
  }

  limitToMaxBits(depth, MAX_BITS);

  for (let i = 0; i < count; i++) lengths[order[i]] = depth[i];
  return count;
}

/**
 * Cap code lengths at `maxBits`, producing a Kraft-valid prefix code (the
 * prefix inequality sum(2^-len) <= 1; DEFLATE permits incomplete codes).
 *
 * Greedy Kraft-budget assignment: symbols are processed deepest-first and each
 * is placed at min(its depth, maxBits) while the 2^-maxBits budget allows; if a
 * code won't fit at its preferred level it is pushed deeper (smaller budget
 * cost). This always yields a valid distribution for N <= 2^maxBits symbols.
 */
export function limitToMaxBits(lengths: Uint8Array, maxBits: number): void {
  let anyOver = false;
  for (let i = 0; i < lengths.length; i++) {
    if (lengths[i] > maxBits) { anyOver = true; break; }
  }
  if (!anyOver) return;

  const order: number[] = [];
  for (let i = 0; i < lengths.length; i++) if (lengths[i] > 0) order.push(i);
  order.sort((a, b) =>
    Math.min(lengths[b], maxBits) - Math.min(lengths[a], maxBits) || a - b);

  const result = new Uint8Array(lengths.length);
  let budget = 1 << maxBits; // total in units of 2^-maxBits
  for (const sym of order) {
    let depth = Math.min(lengths[sym], maxBits);
    let cost = 1 << (maxBits - depth);
    while (cost > budget && depth < maxBits) {
      depth++;
      cost = 1 << (maxBits - depth);
    }
    result[sym] = depth;
    budget -= cost;
  }
  lengths.set(result);
}

export { MAX_BITS as MAX_CODE_LENGTH };

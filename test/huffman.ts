import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { codeLengthsFromFrequencies } from '../src/deflate/bitlen.js';
import { buildHuffman, validateLengths } from '../src/deflate/huffman.js';
import { encodeCodeLengths } from '../src/deflate/blocks.js';

function kraft(lengths: Uint8Array): { sum: number; max: number } {
  let max = 0;
  for (const l of lengths) if (l > max) max = l;
  if (max === 0) return { sum: 0, max: 0 };
  const scale = 1 << max;
  let sum = 0;
  for (const l of lengths) if (l) sum += scale >> l;
  return { sum: sum / scale, max };
}

test('Huffman lengths are optimal for small known frequency sets', () => {
  const cases: Array<{ freq: number[]; expected: number[] }> = [
    { freq: [4, 2, 1, 1], expected: [1, 2, 3, 3] },
    { freq: [1, 1], expected: [1, 1] },
    { freq: [100, 50, 10, 5, 1], expected: [1, 2, 3, 4, 4] },
  ];
  for (const { freq, expected } of cases) {
    const f = new Uint32Array(freq);
    const l = new Uint8Array(freq.length);
    codeLengthsFromFrequencies(f, freq.length, l);
    assert.deepEqual([...l], expected);
  }
});

test('lengths never exceed 15 and Kraft sum is valid for pathological inputs', () => {
  // 500 symbols with wildly skewed frequencies forces deep trees; must clamp.
  const freq = new Uint32Array(500);
  for (let i = 0; i < 500; i++) freq[i] = 1 << Math.min(20, i);
  const lengths = new Uint8Array(500);
  codeLengthsFromFrequencies(freq, 500, lengths);
  for (const l of lengths) assert.ok(l <= 15, `length ${l} > 15`);
  const { sum, max } = kraft(lengths);
  assert.ok(max <= 15);
  assert.ok(Math.abs(sum - 1) < 1e-9 || sum < 1, `Kraft sum ${sum}`);
  validateLengths(lengths);
  buildHuffman(lengths); // must not throw
});

test('equal-frequency symbols get balanced lengths', () => {
  for (const n of [2, 4, 8, 16, 30, 100, 286]) {
    const freq = new Uint32Array(n).fill(12345);
    const lengths = new Uint8Array(n);
    codeLengthsFromFrequencies(freq, n, lengths);
    const depths = new Set<number>();
    for (const l of lengths) depths.add(l);
    // balanced: at most two adjacent depths, all within 15.
    const ds = [...depths];
    assert.ok(ds.every((d) => d <= 15));
    assert.ok(Math.max(...ds) - Math.min(...ds) <= 1, `n=${n} depths ${ds}`);
  }
});

test('code-length run encoding is invertible over fuzzed sequences', () => {
  let seed = 12345;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
  for (let trial = 0; trial < 5000; trial++) {
    const n = 10 + (rnd() % 350);
    const seq: number[] = [];
    for (let i = 0; i < n; i++) {
      const x = rnd();
      if (x % 3 === 0) seq.push(0);
      else if (i > 0 && x % 2 === 0) seq.push(seq[i - 1]);
      else seq.push(1 + (x % 15));
    }
    const enc = encodeCodeLengths(seq);
    const dec: number[] = [];
    for (let i = 0; i < enc.length; i++) {
      const s = enc[i];
      if (s < 16) dec.push(s);
      else if (s === 16) {
        const r = enc[++i] + 3;
        for (let k = 0; k < r; k++) dec.push(dec[dec.length - 1]);
      } else if (s === 17) {
        const r = enc[++i] + 3;
        for (let k = 0; k < r; k++) dec.push(0);
      } else {
        const r = enc[++i] + 11;
        for (let k = 0; k < r; k++) dec.push(0);
      }
    }
    assert.equal(dec.length, seq.length, `trial ${trial} length`);
    for (let i = 0; i < seq.length; i++) {
      assert.equal(dec[i], seq[i], `trial ${trial} index ${i}`);
    }
  }
});

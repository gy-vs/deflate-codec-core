import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { inflateRaw } from '../src/deflate/inflate.js';
import { deflateRaw } from '../src/deflate/deflate.js';
import { deflate, inflate } from '../src/index.js';

function prng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

const eq = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

test('handles every input length 0..300 across our encoder and zlib levels', () => {
  const r = prng(1234);
  for (let n = 0; n <= 300; n++) {
    const data = new Uint8Array(n);
    for (let i = 0; i < n; i++) data[i] = r() % 7;
    // ours -> ours
    const c = deflate(data);
    assert.ok(eq(inflate(c), data), `self n=${n}`);
    // ours -> zlib
    assert.ok(eq(new Uint8Array(zlib.inflateRawSync(Buffer.from(c))), data), `zlib-dec n=${n}`);
    // zlib each level -> ours
    for (let level = 1; level <= 9; level++) {
      const z = new Uint8Array(zlib.deflateRawSync(Buffer.from(data), { level }));
      assert.ok(eq(inflateRaw(z).output, data), `zlib-enc n=${n} L${level}`);
    }
  }
});

test('match distance boundary: 32768 window and just beyond', () => {
  // A 3-byte marker placed at offset 0, repeated near the 32K boundary.
  const data = new Uint8Array(70_000);
  const r = prng(99);
  for (let i = 3; i < data.length; i++) data[i] = 30 + (r() % 200);
  // markers that should be reachable at distance <= 32768
  data[0] = 5; data[1] = 7; data[2] = 9;
  for (const off of [32768, 32769, 32770, 40000, 69997]) {
    data[off] = 5; data[off + 1] = 7; data[off + 2] = 9;
  }
  const c = deflateRaw(data, { level: 9 });
  assert.ok(eq(new Uint8Array(zlib.inflateRawSync(Buffer.from(c.data))), data));
  assert.ok(eq(inflateRaw(c.data).output, data));
});

test('maximum match length 258 runs and long RLE', () => {
  for (const len of [257, 258, 259, 1000, 70000]) {
    const data = new Uint8Array(len);
    data[0] = 1;
    data.fill(1);
    const c = deflate(data);
    assert.ok(eq(inflate(c), data), `rle len ${len}`);
  }
});

test('all 256 byte values and structured binary', () => {
  const data = new Uint8Array(65536);
  for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
  const c = deflate(data);
  assert.ok(eq(inflate(c), data));
  assert.ok(eq(new Uint8Array(zlib.inflateRawSync(Buffer.from(c))), data));
});

test('malformed streams are rejected', () => {
  assert.throws(() => inflateRaw(new Uint8Array([0b111])).output, /block type/i);
  // stored block with bad LEN/NLEN
  const badStored = new Uint8Array([0x01, 10, 0, 0, 0]);
  assert.throws(() => inflateRaw(badStored).output);
  // truncated
  assert.throws(() => inflateRaw(new Uint8Array([0x73])).output);
  // random garbage declared as dynamic
  const r = prng(7);
  const garbage = new Uint8Array(200);
  for (let i = 0; i < garbage.length; i++) garbage[i] = r() & 0xff;
  garbage[0] = (garbage[0] & 0b11111000) | 0b110; // bfinal, btype dynamic
  assert.throws(() => inflateRaw(garbage).output);
});

test('multi-block non-byte-aligned streams via tiny memLevel', () => {
  const data = (() => {
    const r = prng(55);
    const b = new Uint8Array(400_000);
    for (let i = 0; i < b.length; i++) b[i] = 97 + (r() % 6);
    return b;
  })();
  // memLevel 1 => ~few-KB blocks, forcing many packed block boundaries.
  for (const memLevel of [1, 2, 3]) {
    const comp = new Uint8Array(zlib.deflateRawSync(Buffer.from(data), { level: 6, memLevel }));
    assert.ok(eq(inflateRaw(comp).output, data), `memLevel ${memLevel}`);
  }
});

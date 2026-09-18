import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { deflateRaw } from '../src/deflate/deflate.js';
import { inflateRaw } from '../src/deflate/inflate.js';

function prng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const corpora: Record<string, Uint8Array> = {
  empty: new Uint8Array(0),
  one: new Uint8Array([42]),
  two: new Uint8Array([1, 2]),
  zeros: new Uint8Array(100_000).fill(0),
  rle: (() => {
    const b = new Uint8Array(50_000);
    for (let i = 0; i < b.length; i++) b[i] = (i % 7) + 1;
    return b;
  })(),
  logLike: (() => {
    const lines = [
      '2026-09-17T10:00:00.123Z INFO  request_id=abcd handler=/api/v1/orders status=200 latency_ms=12 user=alice\n',
      '2026-09-17T10:00:00.456Z WARN  request_id=ef01 handler=/api/v1/orders status=404 latency_ms=7 user=bob cache=miss\n',
      '2026-09-17T10:00:00.789Z ERROR request_id=2345 handler=/api/v1/payments status=500 latency_ms=88 user=carol err="upstream timeout"\n',
    ];
    const rnd = prng(7);
    const out = new Uint8Array(300_000);
    let p = 0;
    while (p < out.length) {
      const line = lines[rnd() % lines.length];
      for (let i = 0; i < line.length && p < out.length; i++) out[p++] = line.charCodeAt(i);
    }
    return out;
  })(),
  binaryRandom: (() => {
    const rnd = prng(99);
    const b = new Uint8Array(80_000);
    for (let i = 0; i < b.length; i++) b[i] = rnd() & 0xff;
    return b;
  })(),
  text: (() => {
    const words = 'the quick brown fox jumps over the lazy dog while logging request response status latency user agent header cookie session token identifier'.split(' ');
    const rnd = prng(2024);
    let s = '';
    while (s.length < 250_000) s += words[rnd() % words.length] + ' ';
    return Uint8Array.from(s.slice(0, 250_000), (ch) => ch.charCodeAt(0));
  })(),
};

for (const level of [1, 3, 6, 9] as const) {
  test(`our deflate level ${level} is gunzip-compatible (zlib inflateRaw) and self-inflates`, () => {
    for (const [name, data] of Object.entries(corpora)) {
      const { data: comp } = deflateRaw(data, { level });
      // zlib must decode our stream byte-exact.
      const byZlib = zlib.inflateRawSync(Buffer.from(comp));
      assert.ok(bytesEqual(new Uint8Array(byZlib), data), `${name}: zlib roundtrip`);
      // Our own decoder too.
      const byOurs = inflateRaw(comp).output;
      assert.ok(bytesEqual(byOurs, data), `${name}: self roundtrip`);
    }
  });
}

test('zlib levels 1..9 all decode byte-exact with our inflate (mixed block types)', () => {
  const data = corpora.logLike;
  for (let level = 1; level <= 9; level++) {
    const comp = new Uint8Array(zlib.deflateRawSync(Buffer.from(data), { level }));
    const out = inflateRaw(comp).output;
    assert.ok(bytesEqual(out, data), `zlib level ${level} roundtrip`);
  }
});

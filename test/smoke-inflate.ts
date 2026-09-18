import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import zlib from 'node:zlib';
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

const corpora: Record<string, Uint8Array> = {
  empty: new Uint8Array(0),
  one: new Uint8Array([42]),
  zeros: new Uint8Array(50_000).fill(0),
  rle: (() => {
    const b = new Uint8Array(30_000);
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
    const b = new Uint8Array(100_000);
    for (let i = 0; i < b.length; i++) b[i] = rnd() & 0xff;
    return b;
  })(),
  smallAlphabet: (() => {
    const rnd = prng(123);
    const b = new Uint8Array(120_000);
    for (let i = 0; i < b.length; i++) b[i] = rnd() % 4;
    return b;
  })(),
  longDist: (() => {
    // a pattern at the start repeated ~40KB later to exercise large distances
    const b = new Uint8Array(70_000);
    const rnd = prng(5);
    for (let i = 0; i < 4000; i++) b[i] = rnd() & 0xff;
    for (let i = 0; i < 4000; i++) b[40_000 + i] = b[i];
    return b;
  })(),
  text: (() => {
    const words = 'the quick brown fox jumps over the lazy dog while logging request response status latency user agent header cookie session token'.split(' ');
    const rnd = prng(2024);
    let s = '';
    while (s.length < 250_000) s += words[rnd() % words.length] + ' ';
    return Uint8Array.from(s.slice(0, 250_000), (ch) => ch.charCodeAt(0));
  })(),
};

test('inflate zlib raw levels 1..9 across corpora', () => {
  for (const [name, data] of Object.entries(corpora)) {
    for (let level = 1; level <= 9; level++) {
      const memLevel = 8;
      const comp = zlib.deflateRawSync(data, { level, memLevel });
      let output: Uint8Array;
      try {
        output = inflateRaw(comp).output;
      } catch (e) {
        assert.fail(`${name} level ${level}: ${(e as Error).message}`);
      }
      assert.equal(output.length, data.length, `${name} level ${level}: length`);
      let diff = -1;
      for (let i = 0; i < data.length; i++) {
        if (output[i] !== data[i]) { diff = i; break; }
      }
      assert.equal(diff, -1, `${name} level ${level}: first byte diff at ${diff}`);
    }
  }
});

test('inflate handles non-byte-aligned multi-block streams', () => {
  // Force zlib to emit many blocks via small memLevel; block boundaries are
  // generally not byte aligned (Huffman blocks stay packed).
  const data = corpora.logLike;
  for (let memLevel = 1; memLevel <= 2; memLevel++) {
    const comp = zlib.deflateRawSync(data, { level: 6, memLevel });
    const output = inflateRaw(comp).output;
    assert.equal(output.length, data.length, `memLevel ${memLevel} length`);
    let diff = -1;
    for (let i = 0; i < data.length; i++) if (output[i] !== data[i]) { diff = i; break; }
    assert.equal(diff, -1, `memLevel ${memLevel} byte diff at ${diff}`);
  }
});

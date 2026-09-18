import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  gzip,
  gunzip,
  compressSeekable,
  inflateRange,
  inflateSeekBlock,
  serializeIndex,
  deserializeIndex,
} from '../src/index.js';

function prng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

function logCorpus(n: number, seed = 7): Uint8Array {
  const lines = [
    '2026-09-17T10:00:00.123Z INFO  request_id=abcd handler=/api/v1/orders status=200 latency_ms=12 user=alice\n',
    '2026-09-17T10:00:00.456Z WARN  request_id=ef01 handler=/api/v1/orders status=404 latency_ms=7 user=bob cache=miss\n',
    '2026-09-17T10:00:00.789Z ERROR request_id=2345 handler=/api/v1/payments status=500 latency_ms=88 user=carol err="timeout"\n',
  ];
  const r = prng(seed);
  const out = new Uint8Array(n);
  let p = 0;
  while (p < n) {
    const line = lines[r() % lines.length];
    for (let i = 0; i < line.length && p < n; i++) out[p++] = line.charCodeAt(i);
  }
  return out;
}

test('gzip output is decodable by the system gunzip and has correct header/footer', () => {
  for (const data of [new Uint8Array(0), new Uint8Array([1]), logCorpus(50_000)]) {
    const gz = gzip(data);
    // magic
    assert.equal(gz[0], 0x1f);
    assert.equal(gz[1], 0x8b);
    assert.equal(gz[2], 8);
    // zlib gunzip (what downstream teams use)
    const bySystem = new Uint8Array(zlib.gunzipSync(Buffer.from(gz)));
    assert.deepEqual(bySystem, data);
    // our own gunzip verifies CRC + ISIZE
    assert.deepEqual(gunzip(gz), data);
  }
});

test('gzip with FNAME round-trips through zlib and our decoder', () => {
  const data = logCorpus(20_000);
  const gz = gzip(data, { fileName: 'app-2026-09-17.log', mtime: 1758000000 });
  assert.deepEqual(new Uint8Array(zlib.gunzipSync(Buffer.from(gz))), data);
  assert.deepEqual(gunzip(gz), data);
  // FNAME flag set
  assert.ok(gz[3] & 0x08);
});

test('seekable compression index points are valid and ranged inflate matches', () => {
  const data = logCorpus(200_000);
  const interval = 16384;
  const { gzip: gz, deflate: def, index } = compressSeekable(data, interval);
  // Standard gzip still valid.
  assert.deepEqual(new Uint8Array(zlib.gunzipSync(Buffer.from(gz))), data);
  assert.deepEqual(gunzip(gz), data);

  const pts = (index as unknown as { points: Array<{ uncompressedOffset: number; compressedBitOffset: number; uncompressedLength: number }> }).points;
  // First point at offset 0; offsets strictly increasing; each independent.
  assert.equal(pts[0].uncompressedOffset, 0);
  for (let i = 1; i < pts.length; i++) {
    assert.ok(pts[i].uncompressedOffset > pts[i - 1].uncompressedOffset);
    assert.ok(pts[i].compressedBitOffset > pts[i - 1].compressedBitOffset);
  }

  // Every block decoded on its own reproduces its slice exactly.
  for (const pt of pts) {
    const block = inflateSeekBlock(def, pt.compressedBitOffset);
    const expected = data.subarray(pt.uncompressedOffset, pt.uncompressedOffset + pt.uncompressedLength);
    assert.deepEqual(block, expected, `block at ${pt.uncompressedOffset}`);
  }

  // Ranged queries over many boundaries match the corresponding source slice.
  const ranges: Array<[number, number]> = [
    [0, 1],
    [0, interval],
    [10, 10_000],
    [interval - 5, interval + 5], // crosses first boundary
    [interval * 2 + 123, interval * 4 + 777],
    [data.length - 100, data.length],
    [data.length, data.length],
  ];
  for (const [s, e] of ranges) {
    const got = inflateRange(def, index, s, e);
    assert.deepEqual(got, data.subarray(s, e), `range ${s}..${e}`);
  }
});

test('index serialization round-trips and stays usable', () => {
  const data = logCorpus(80_000);
  const { deflate: def, index } = compressSeekable(data, 10_000);
  const json = JSON.stringify(serializeIndex(index));
  const restored = deserializeIndex(JSON.parse(json));
  const got = inflateRange(def, restored, 12_345, 45_678);
  assert.deepEqual(got, data.subarray(12_345, 45_678));
});

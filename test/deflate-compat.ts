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
const eq = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

// Many data shapes so zlib picks varied block types / tree shapes.
function makeCorpora(): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  out.empty = new Uint8Array(0);
  out.fewBytes = new Uint8Array([1, 2, 3, 1, 2, 3]);
  // Each single byte value repeated.
  for (let v = 0; v < 256; v += 37) out[`fill${v}`] = new Uint8Array(5000).fill(v);
  // Low-entropy with 2, 3, 4, 8, 16, 64 symbols.
  for (const alpha of [2, 3, 4, 8, 16, 64]) {
    const r = prng(alpha * 131 + 1);
    const b = new Uint8Array(60_000);
    for (let i = 0; i < b.length; i++) b[i] = r() % alpha;
    out[`alpha${alpha}`] = b;
  }
  // Fully random (stored blocks expected).
  {
    const r = prng(4242);
    const b = new Uint8Array(60_000);
    for (let i = 0; i < b.length; i++) b[i] = r() & 0xff;
    out.random = b;
  }
  // Mixed text with binary blobs.
  {
    const r = prng(999);
    const b = new Uint8Array(80_000);
    for (let i = 0; i < b.length; i++) {
      b[i] = (i & 4096) === 0 ? (97 + r() % 26) : (r() & 0xff);
    }
    out.mixed = b;
  }
  return out;
}

test('inflate every zlib level x strategy combination byte-exact', () => {
  const corpora = makeCorpora();
  const strategies = [
    zlib.constants.Z_DEFAULT_STRATEGY,
    zlib.constants.Z_HUFFMAN_ONLY,
    zlib.constants.Z_RLE,
    zlib.constants.Z_FILTERED,
    zlib.constants.Z_FIXED,
  ];
  for (const [name, data] of Object.entries(corpora)) {
    for (let level = 1; level <= 9; level++) {
      for (const strategy of strategies) {
        let comp: Buffer;
        try {
          comp = zlib.deflateRawSync(Buffer.from(data), { level, strategy });
        } catch {
          continue; // some combos reject empty input etc.
        }
        const got = inflateRaw(new Uint8Array(comp)).output;
        assert.ok(eq(got, data), `${name} L${level} strat ${strategy}`);
      }
    }
  }
});

test('inflate streams forced into many packed blocks at all memLevels', () => {
  const corpora = makeCorpora();
  for (const [name, data] of Object.entries(corpora)) {
    if (data.length < 1000) continue;
    for (let memLevel = 1; memLevel <= 9; memLevel++) {
      // Small window bits also vary block/flush behavior; keep raw deflate.
      const comp = new Uint8Array(zlib.deflateRawSync(Buffer.from(data), {
        level: 6, memLevel, strategy: zlib.constants.Z_DEFAULT_STRATEGY,
      }));
      assert.ok(eq(inflateRaw(comp).output, data), `${name} memLevel ${memLevel}`);
    }
  }
});

test('inflate streams produced with Z_SYNC_FLUSH (byte-aligned boundaries)', async () => {
  const r = prng(31);
  const chunks: Buffer[] = [];
  const def = zlib.createDeflateRaw({ level: 6 });
  const all = await new Promise<Buffer>((resolve) => {
    const sink: Buffer[] = [];
    def.on('data', (d: Buffer) => sink.push(d));
    def.on('end', () => resolve(Buffer.concat(sink)));
    for (let c = 0; c < 20; c++) {
      const b = Buffer.alloc(3000 + (r() % 4000));
      for (let i = 0; i < b.length; i++) b[i] = 97 + (r() % 10);
      chunks.push(b);
      def.write(b);
      def.flush(zlib.constants.Z_SYNC_FLUSH);
    }
    def.end();
  });
  const inflated = inflateRaw(new Uint8Array(all)).output;
  const expected = Buffer.concat(chunks);
  assert.ok(eq(inflated, new Uint8Array(expected)));
});

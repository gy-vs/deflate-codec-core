/**
 * Trade-off report: compressed size and seek granularity as the seek interval
 * varies. Run with: npm run bench (see package.json).
 *
 * Prints a table comparing each interval against zlib level 6 with no seek
 * points, so the compression-ratio cost of window resetting is directly visible.
 */
import zlib from 'node:zlib';
import { deflateRaw } from '../src/deflate/deflate.js';

function prng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

export function buildLogCorpus(bytes: number, seed = 7): Uint8Array {
  const templates = [
    '2026-09-17T10:00:00.123Z INFO  request_id=$RID handler=/api/v1/orders status=200 latency_ms=$MS user=alice region=us-east-1\n',
    '2026-09-17T10:00:00.456Z WARN  request_id=$RID handler=/api/v1/payments status=404 latency_ms=$MS user=bob region=eu-west-1 cache=miss\n',
    '2026-09-17T10:00:00.789Z ERROR request_id=$RID handler=/api/v1/search status=500 latency_ms=$MS user=carol err="upstream timeout" retries=3\n',
  ];
  const r = prng(seed);
  const out = new Uint8Array(bytes);
  let p = 0;
  while (p < bytes) {
    const t = templates[r() % templates.length];
    const rid = (r() >>> 0).toString(16).padStart(8, '0');
    const ms = String(r() % 500);
    const line = t.replace('$RID', rid).replace('$MS', ms);
    for (let i = 0; i < line.length && p < bytes; i++) out[p++] = line.charCodeAt(i);
  }
  return out;
}

function main(): void {
  const size = Number(process.argv[2] ?? 20_000_000);
  const data = buildLogCorpus(size);
  const z6 = zlib.deflateRawSync(Buffer.from(data), { level: 6 }).length;
  const noSeek = deflateRaw(data, { level: 6 }).data.length;

  console.log(`corpus: ${(size / 1e6).toFixed(1)} MB log-like data`);
  console.log(`zlib -6 (no seek points): ${(z6 / 1024).toFixed(1)} KiB`);
  console.log(`ours -6 (no seek points): ${(noSeek / 1024).toFixed(1)} KiB  ratio vs zlib ${(noSeek / z6).toFixed(4)}`);
  console.log('');
  console.log('seek interval | blocks | compressed KiB | ratio vs zlib -6 | vs no-seek');
  const intervals = [4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1_048_576];
  for (const iv of intervals) {
    const t0 = performance.now();
    const res = deflateRaw(data, { level: 6, seekInterval: iv });
    const ms = performance.now() - t0;
    const kib = res.data.length / 1024;
    console.log(
      `${String(iv).padStart(13)} | ${String(res.index.length).padStart(6)} | ${kib.toFixed(1).padStart(14)} | ${(res.data.length / z6).toFixed(5).padStart(16)} | x${(res.data.length / noSeek).toFixed(3)}  ${(size / 1e6 / (ms / 1000)).toFixed(1)} MB/s`,
    );
  }
}

main();

/**
 * 真实日志语料上的压缩率对照（zlib -6）与跳转间隔取舍。
 */
import zlib from 'node:zlib';
import { gzipSync, gunzipSync } from '../src/index';
import { gzipSyncIndexed } from '../src/seek';
import { realisticLogs } from './corpus';

function mb(n: number): string {
  return (n / 1048576).toFixed(2) + 'MB';
}

function main(): void {
  const size = Number(process.argv[2] ?? 50_000_000);
  const data = realisticLogs(size);
  console.log(`corpus: ${mb(size)} realistic logs`);

  const t0 = Date.now();
  const z6 = zlib.gzipSync(Buffer.from(data), { level: 6 });
  console.log(`zlib -6 : ${mb(z6.length)}  ${Date.now() - t0}ms  ratio=${(z6.length / size).toFixed(4)}`);

  const t1 = Date.now();
  const ours = gzipSync(data);
  const ms = Date.now() - t1;
  const vs = ours.length / z6.length;
  console.log(
    `ours    : ${mb(ours.length)}  ${ms}ms  ratio=${(ours.length / size).toFixed(4)}  vs zlib=${vs.toFixed(4)} ${vs <= 1.05 ? 'PASS' : 'FAIL'}`,
  );
  const mbps = size / ms / 1024;
  console.log(`speed: ${mbps.toFixed(1)} MB/s -> 1GB ≈ ${(1073741824 / (size / (ms / 1000)) / 60).toFixed(2)} min`);

  const t2 = Date.now();
  const back = gunzipSync(ours);
  console.log(`inflate : ${Date.now() - t2}ms, ok=${back.length === size}`);

  console.log('\ninterval     comp       ratio    vs zlib6   granularity');
  for (const interval of [8192, 32768, 131072, 524288, 2097152, Infinity]) {
    const { data: comp } = gzipSyncIndexed(data, interval);
    console.log(
      `${interval === Infinity ? '     none' : String(interval).padStart(9)}  ${mb(comp.length).padStart(9)}  ${(comp.length / size).toFixed(4)}   ${(comp.length / z6.length).toFixed(4)}      ${interval === Infinity ? 'whole file' : mb(interval)}`,
    );
  }
}

main();

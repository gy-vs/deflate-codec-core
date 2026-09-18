/**
 * 压缩率与速度基准：
 *  - 不设跳转点时与 zlib level 6 对比体积（要求 <= zlib * 1.05）；
 *  - 不同 seekInterval 下压缩率 vs 跳转粒度的取舍；
 *  - 压缩速度（外推 1GB 是否 < 10 分钟）。
 * 仅作为可手动运行的基准，不进默认测试断言（机器相关）。
 */
import zlib from 'node:zlib';
import { gzipSync } from '../src/index';
import { gzipSyncIndexed } from '../src/seek';

function logCorpus(total: number): Uint8Array {
  const lines = [
    '2026-09-17 10:00:01 INFO  request received path=/api/users id=42 ua="Mozilla/5.0"\n',
    '2026-09-17 10:00:02 WARN  cache miss key=session:9f3a latency=12ms region=us-east\n',
    '2026-09-17 10:00:03 ERROR upstream timeout service=billing retries=3 trace=abc123\n',
    '2026-09-17 10:00:04 DEBUG payload={"user":"alice","action":"login","ok":true}\n',
    '2026-09-17 10:00:05 INFO  200 GET /static/app.js bytes=842113 etag=W/"9f3a"\n',
  ];
  const out = new Uint8Array(total);
  let s = 1;
  let li = 0;
  let p = 0;
  while (p < total) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    if (s % 7 === 0) li = (li + 1) % lines.length;
    const line = lines[li];
    for (let k = 0; k < line.length && p < total; k++) out[p++] = line.charCodeAt(k);
  }
  return out;
}

function mb(n: number): string {
  return (n / 1048576).toFixed(2) + 'MB';
}

function main(): void {
  const size = Number(process.argv[2] ?? 20_000_000);
  console.log(`corpus size: ${mb(size)}`);
  const data = logCorpus(size);

  // zlib level 6 参考
  const t0 = Date.now();
  const z6 = zlib.gzipSync(Buffer.from(data), { level: 6 });
  const zlibMs = Date.now() - t0;
  console.log(`zlib -6 : ${mb(z6.length)}  ${zlibMs}ms  ratio=${(z6.length / size).toFixed(4)}`);

  // 本库，不设跳转点
  const t1 = Date.now();
  const ours = gzipSync(data);
  const ourMs = Date.now() - t1;
  const ratioVsZlib = ours.length / z6.length;
  console.log(
    `ours    : ${mb(ours.length)}  ${ourMs}ms  ratio=${(ours.length / size).toFixed(4)}  vs zlib=${(ratioVsZlib).toFixed(4)}`,
  );
  console.log(
    ratioVsZlib <= 1.05 ? 'PASS: <= zlib * 1.05' : 'FAIL: > zlib * 1.05',
  );

  const throughputMBs = size / ourMs / 1024; // bytes/ms ~= MB/s 的 1000 倍换算
  const gbSeconds = 1073741824 / (size / (ourMs / 1000));
  console.log(`throughput: ${throughputMBs.toFixed(1)} MB/s -> 1GB ≈ ${(gbSeconds / 60).toFixed(2)} min`);
  console.log(gbSeconds < 600 ? 'PASS: 1GB < 10min' : 'FAIL: 1GB > 10min');

  // 解压速度
  const t2 = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { gunzipSync } = require('../src/index');
  gunzipSync(ours);
  const infMs = Date.now() - t2;
  console.log(`inflate : ${infMs}ms (${(size / infMs / 1024).toFixed(1)} MB/s)`);

  console.log('\nseek interval trade-off:');
  console.log('interval   compressed   ratio vs raw   vs zlib(-6)   granularity');
  for (const interval of [4096, 16384, 65536, 262144, 1048576]) {
    const { data: comp } = gzipSyncIndexed(data, interval);
    const r = comp.length / size;
    const vs = comp.length / z6.length;
    console.log(
      `${String(interval).padStart(9)} ${mb(comp.length).padStart(11)}   ${r.toFixed(4)}        ${vs.toFixed(4)}        ${mb(interval)}`,
    );
  }
}

main();

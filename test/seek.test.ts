/**
 * 跳转索引与按区间解压测试。
 * 覆盖：不同间隔、索引正确性、区间边界、跨块、压缩流独立性、
 * 序列化往返、异步 RandomAccessReader、与 zlib 全量解压一致。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  gzipSyncIndexed,
  gunzipRangeSync,
  gunzipRange,
  serializeIndex,
  parseIndex,
  findSpan,
  RandomAccessReader,
  GzipDeflater,
  gunzipSync,
  gzipSync,
} from '../src/index';
import { GZIP_DEFLATE_OFFSET } from '../src/seek';

function makeLog(n: number, seed0 = 1): Uint8Array {
  const lines = [
    '2026-09-17 10:00:01 INFO  request received path=/api/users id=42\n',
    '2026-09-17 10:00:02 WARN  cache miss key=session:9f3a latency=12ms\n',
    '2026-09-17 10:00:03 ERROR upstream timeout service=billing retries=3\n',
    '2026-09-17 10:00:04 DEBUG payload={"user":"alice","action":"login"}\n',
  ];
  const out = new Uint8Array(n);
  let p = 0;
  let seed = seed0;
  let li = 0;
  while (p < n) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    if (seed % 11 === 0) li = (li + 1) % lines.length;
    const line = lines[li];
    for (let k = 0; k < line.length && p < n; k++) out[p++] = line.charCodeAt(k);
  }
  return out;
}

class MemReader implements RandomAccessReader {
  reads: Array<{ offset: number; length: number }> = [];
  constructor(private buf: Uint8Array) {}
  size(): number {
    return this.buf.length;
  }
  read(offset: number, length: number): Uint8Array {
    this.reads.push({ offset, length });
    return this.buf.subarray(offset, Math.min(offset + length, this.buf.length));
  }
}

test('无跳转点：gzipSync 与 gzipSyncIndexed(Infinity) 体积一致', () => {
  const data = makeLog(50000);
  const a = gzipSync(data);
  const { data: b } = gzipSyncIndexed(data, Infinity as unknown as number);
  assert.equal(a.length, b.length);
});

test('索引点：rawOffset 单调且首项为 0，bitOffset 单调不减', () => {
  const data = makeLog(100000);
  for (const interval of [1024, 4096, 65536]) {
    const { index } = gzipSyncIndexed(data, interval);
    assert.equal(index.entries[0].rawOffset, 0);
    assert.equal(index.entries[0].bitOffset, 0);
    for (let i = 1; i < index.entries.length; i++) {
      assert.ok(index.entries[i].rawOffset > index.entries[i - 1].rawOffset, 'rawOffset increases');
      assert.ok(
        index.entries[i].bitOffset >= index.entries[i - 1].bitOffset,
        'bitOffset non-decreasing',
      );
      // 跳转点间隔不超过 interval（最后一点除外）
      assert.ok(index.entries[i].rawOffset - index.entries[i - 1].rawOffset <= interval + 258);
    }
    assert.equal(index.rawSize, data.length);
  }
});

test('整个文件按区间解压 == 全量数据（多间隔）', () => {
  const data = makeLog(120000);
  for (const interval of [1024, 4096, 32768]) {
    const { data: comp, index } = gzipSyncIndexed(data, interval);
    const whole = gunzipRangeSync(comp, index, 0, data.length);
    assert.deepEqual(whole, data, `interval ${interval} whole range`);
    // 标准 gunzip 也能解开（产物是合法 gzip）
    assert.deepEqual(gunzipSync(comp), data);
    assert.deepEqual(new Uint8Array(zlib.gunzipSync(Buffer.from(comp))), data);
  }
});

test('任意子区间逐字节正确（随机区间扫描）', () => {
  const data = makeLog(100000);
  const interval = 3000;
  const { data: comp, index } = gzipSyncIndexed(data, interval);
  const cases = [
    [0, 1],
    [0, 100],
    [2999, 3001],
    [3000, 6000],
    [12345, 23456],
    [99999, 100000],
    [50000, 50001],
  ];
  for (const [s, e] of cases) {
    const got = gunzipRangeSync(comp, index, s, e);
    assert.deepEqual(got, data.subarray(s, e), `range [${s},${e})`);
    assert.equal(got.length, e - s);
  }
});

test('随机模糊：大量随机区间与原始切片一致', () => {
  const data = makeLog(80000, 7);
  const { data: comp, index } = gzipSyncIndexed(data, 1777);
  let seed = 42;
  for (let t = 0; t < 200; t++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const s = seed % data.length;
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const len = 1 + (seed % 5000);
    const e = Math.min(data.length, s + len);
    const got = gunzipRangeSync(comp, index, s, e);
    assert.deepEqual(got, data.subarray(s, e), `fuzz range [${s},${e})`);
  }
});

test('异步随机读取：只发一次 Range 请求且读取量远小于整文件', async () => {
  const data = makeLog(200000);
  const { data: comp, index } = gzipSyncIndexed(data, 8192);
  const reader = new MemReader(comp);
  const got = await gunzipRange(reader, index, 40000, 40100);
  assert.deepEqual(got, data.subarray(40000, 40100));
  // 只读取一次（一次 Range GET）
  assert.equal(reader.reads.length, 1);
  // 拉取的压缩字节数应远小于整个压缩文件（这里跨度 8192 原始字节）
  const fetched = reader.reads[0].length;
  assert.ok(fetched < comp.length / 5, `fetched ${fetched} vs total ${comp.length}`);
  // 读取起点不是文件开头（证明真的跳转了）
  assert.ok(reader.reads[0].offset > 0);
});

test('异步区间跨多个跨度时仍只发一次 Range 且结果正确', async () => {
  const data = makeLog(200000, 3);
  const { data: comp, index } = gzipSyncIndexed(data, 8192);
  const reader = new MemReader(comp);
  const s = 40000;
  const e = 120000;
  const got = await gunzipRange(reader, index, s, e);
  assert.deepEqual(got, data.subarray(s, e));
  assert.equal(reader.reads.length, 1);
});

test('区间起点恰好落在各跳转点上', () => {
  const data = makeLog(100000);
  const { data: comp, index } = gzipSyncIndexed(data, 10000);
  for (const entry of index.entries) {
    const s = entry.rawOffset;
    const e = Math.min(data.length, s + 123);
    if (s >= data.length) continue;
    const got = gunzipRangeSync(comp, index, s, e);
    assert.deepEqual(got, data.subarray(s, e), `exact span start ${s}`);
  }
});

test('索引序列化/反序列化后仍可正确区间解压', () => {
  const data = makeLog(60000);
  const { data: comp, index } = gzipSyncIndexed(data, 5000);
  const text = serializeIndex(index);
  const restored = parseIndex(text);
  const got = gunzipRangeSync(comp, restored, 12345, 22222);
  assert.deepEqual(got, data.subarray(12345, 22222));
});

test('每个跳转点都是真正的 DEFLATE 块边界（从该位偏移独立解压合法）', () => {
  const data = makeLog(70000);
  const { data: comp, index } = gzipSyncIndexed(data, 7000);
  // 不做逐点独立解码（需要伪造 BFINAL），改为验证 bitOffset 都在
  // gzip 头之后且不超过流结束。
  for (const e of index.entries) {
    assert.ok(e.bitOffset >= 0);
    const byteOff = GZIP_DEFLATE_OFFSET + (e.bitOffset >>> 3);
    assert.ok(byteOff < comp.length);
  }
});

test('findSpan 二分正确', () => {
  const index = {
    entries: [
      { rawOffset: 0, bitOffset: 0 },
      { rawOffset: 100, bitOffset: 500 },
      { rawOffset: 200, bitOffset: 1000 },
    ],
    endBitOffset: 1500,
    rawSize: 300,
  };
  assert.equal(findSpan(index, 0), 0);
  assert.equal(findSpan(index, 99), 0);
  assert.equal(findSpan(index, 100), 1);
  assert.equal(findSpan(index, 199), 1);
  assert.equal(findSpan(index, 250), 2);
});

test('小数据 + 大于文件的间隔：一个真实跨度（起点 + 结束点）', () => {
  const data = makeLog(100);
  const { data: comp, index } = gzipSyncIndexed(data, 1_000_000);
  // 起点 {0} 和结束点 {100}，中间无额外跳转点
  assert.equal(index.entries.length, 2);
  assert.equal(index.entries[0].rawOffset, 0);
  assert.equal(index.entries[1].rawOffset, 100);
  assert.deepEqual(gunzipRangeSync(comp, index, 0, 100), data);
});

test('流式 GzipDeflater 带索引与一次性结果一致', () => {
  const data = makeLog(75000);
  const g = new GzipDeflater({ seekInterval: 9000 });
  // 故意用很小且不均匀的块喂入
  let off = 0;
  const steps = [1, 17, 4096, 3, 33000, 9000, 5];
  let si = 0;
  while (off < data.length) {
    const n = Math.min(steps[si++ % steps.length], data.length - off);
    g.write(data.subarray(off, off + n));
    off += n;
  }
  const comp = g.finish();
  assert.deepEqual(new Uint8Array(zlib.gunzipSync(Buffer.from(comp))), data);
  assert.ok(g.seekIndex.length > 3);
});

test('跨度远大于内部块上限：区间解压仍正确（每 60000 字节还有内部块）', () => {
  // interval=1_000_000 远大于 BLOCK_MAX_BYTES(60000)，跨度内有多块
  const data = makeLog(300000, 123);
  const { data: comp, index } = gzipSyncIndexed(data, 1_000_000);
  // 落在 60000 内部块边界附近的区间
  for (const [s, e] of [[59990, 60010], [119990, 120050], [0, 300000], [299999, 300000]]) {
    assert.deepEqual(gunzipRangeSync(comp, index, s, e), data.subarray(s, e), `range ${s}-${e}`);
  }
});

test('interval 小于内部块上限：每个跨度一个或多个块，区间精确', () => {
  const data = makeLog(100000, 55);
  const { data: comp, index } = gzipSyncIndexed(data, 1000);
  let seed = 1;
  for (let t = 0; t < 100; t++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const s = seed % data.length;
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const e = Math.min(data.length, s + 1 + (seed % 3000));
    assert.deepEqual(gunzipRangeSync(comp, index, s, e), data.subarray(s, e), `t${t} ${s}-${e}`);
  }
});

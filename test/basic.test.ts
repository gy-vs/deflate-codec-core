/**
 * 基础往返测试：随机/重复/文本/二进制数据，压缩再解压逐字节比对。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, inflateSync, gzipSync, gunzipSync } from '../src/index';

function check(data: Uint8Array, label: string): void {
  const def = deflateSync(data);
  const back = inflateSync(def);
  assert.deepEqual(back, data, `raw deflate roundtrip: ${label}`);

  const gz = gzipSync(data);
  const back2 = gunzipSync(gz);
  assert.deepEqual(back2, data, `gzip roundtrip: ${label}`);

  // gzip 头魔数与 CM
  assert.equal(gz[0], 0x1f);
  assert.equal(gz[1], 0x8b);
  assert.equal(gz[2], 8);
}

test('空输入', () => {
  check(new Uint8Array(0), 'empty');
});

test('单字节', () => {
  for (let b = 0; b < 256; b += 37) {
    check(new Uint8Array([b]), `byte ${b}`);
  }
});

test('短文本', () => {
  check(new TextEncoder().encode('hello hello hello world'), 'short text');
});

test('完全相同字节（长串重复）', () => {
  check(new Uint8Array(50000).fill(0x41), '50k same');
  check(new Uint8Array(200000).fill(0x00), '200k zeros');
});

test('周期重复（远距离匹配）', () => {
  const period = new Uint8Array(1000);
  for (let i = 0; i < 1000; i++) period[i] = (i * 31 + 7) & 0xff;
  const data = new Uint8Array(1000 * 40);
  for (let rep = 0; rep < 40; rep++) data.set(period, rep * 1000);
  check(data, 'periodic 40k');
});

test('超过 32K 窗口的重复（dist 32768）', () => {
  const data = new Uint8Array(100000);
  for (let i = 0; i < 100000; i++) data[i] = i & 0xff;
  // 构造相距 32768 的相同段
  for (let i = 0; i < 300; i++) data[40000 + i] = data[40000 + i - 32768];
  check(data, 'dist 32768');
});

test('随机不可压缩数据', () => {
  const data = new Uint8Array(100000);
  let seed = 12345;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = seed & 0xff;
  }
  check(data, 'random 100k');
});

test('跨多次 write 的流式输入', () => {
  const full = new TextEncoder().encode('the quick brown fox '.repeat(5000));
  const gz = gzipSync(full);
  void gz;
  const { GzipDeflater } = require('../src/gzip') as typeof import('../src/gzip');
  const g = new GzipDeflater();
  for (let off = 0; off < full.length; off += 997) {
    g.write(full.subarray(off, Math.min(off + 997, full.length)));
  }
  const data = g.finish();
  assert.deepEqual(gunzipSync(data), full);
});

test('大块混合数据（约 1MB）', () => {
  const data = new Uint8Array(1_000_000);
  let seed = 999;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = (seed >> 8) & 0xff;
    if (i % 97 === 0) data[i] = 0x20;
    if (i % 1009 === 0) data[i] = 0x0a;
  }
  check(data, 'mixed 1MB');
});

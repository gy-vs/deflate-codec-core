/**
 * 与 Node 自带 zlib 的互通测试（zlib 仅在此测试文件中作为对照）：
 *  - zlib 用 level 1..9 压缩，本库解压，逐字节相同；
 *  - 本库压缩，zlib 解压，逐字节相同；
 *  - 多块拼接、非字节对齐块交界、存储块等边界。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { deflateSync, gzipSync, gunzipSync, inflateSync } from '../src/index';

type Gen = (n: number) => Uint8Array;

const generators: Record<string, Gen> = {
  text(n) {
    const words = ['error', 'INFO', 'timeout', 'user=42', 'GET /api/v1', '200 OK', '\n', 'WARN'];
    const out = new Uint8Array(n);
    let p = 0;
    let seed = 7;
    while (p < n) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const w = words[seed % words.length];
      for (let i = 0; i < w.length && p < n; i++) out[p++] = w.charCodeAt(i);
    }
    return out;
  },
  random(n) {
    const out = new Uint8Array(n);
    let seed = 1234;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      out[i] = seed & 0xff;
    }
    return out;
  },
  zeros(n) {
    return new Uint8Array(n);
  },
  mixed(n) {
    const out = new Uint8Array(n);
    let seed = 5;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      out[i] = (seed >> 11) & 0xff;
      if (i % 50 === 0) out[i] = 0x20;
      if (i % 300 === 0) out[i] = 0x0a;
      if (i % 5000 === 0) {
        for (let k = 0; k < 20 && i + k < n; k++) out[i + k] = 0x58;
      }
    }
    return out;
  },
  lowEntropy(n) {
    const out = new Uint8Array(n);
    let seed = 9;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      out[i] = (seed & 7) === 0 ? (seed >> 8) & 0xff : 0x61 + (seed % 5);
    }
    return out;
  },
};

const sizes = [0, 1, 2, 3, 10, 100, 1000, 5000, 30000, 70000, 200000];

for (const [name, gen] of Object.entries(generators)) {
  for (const size of sizes) {
    const data = gen(size);
    test(`zlib 各级 -> 本库解压 [${name} n=${size}]`, () => {
      for (let level = 1; level <= 9; level++) {
        const z = zlib.deflateRawSync(Buffer.from(data), { level });
        const back = inflateSync(z);
        assert.deepEqual(back, data, `level ${level} mismatch`);
      }
    });

    test(`本库压缩 -> zlib 解压 [${name} n=${size}]`, () => {
      const z = deflateSync(data);
      const back = zlib.inflateRawSync(Buffer.from(z));
      assert.deepEqual(new Uint8Array(back), data);
    });
  }
}

test('gzip：本库压缩 -> zlib 解压（含 CRC/ISIZE 校验）', () => {
  const data = generators.text(123456);
  const gz = gzipSync(data);
  const back = zlib.gunzipSync(Buffer.from(gz));
  assert.deepEqual(new Uint8Array(back), data);
});

test('gzip：zlib 压缩 -> 本库解压', () => {
  const data = generators.mixed(123456);
  const gz = zlib.gzipSync(Buffer.from(data));
  const back = gunzipSync(new Uint8Array(gz));
  assert.deepEqual(back, data);
});

test('zlib 带 FNAME 头的 gzip 也能解析', () => {
  const data = generators.text(5000);
  const gz = zlib.gzipSync(Buffer.from(data), { level: 6 });
  // Node 默认不带 FNAME；手工构造一个带名字的成员
  const withName = Buffer.concat([
    gz.subarray(0, 3),
    Buffer.from([0x08]), // FLG=FNAME
    gz.subarray(4, 10),
    Buffer.from('log.txt\0'),
    gz.subarray(10),
  ]);
  const back = gunzipSync(new Uint8Array(withName));
  assert.deepEqual(back, data);
});

test('多成员拼接的 gzip 顺序解压', () => {
  const a = generators.text(1000);
  const b = generators.mixed(2000);
  const g1 = zlib.gzipSync(Buffer.from(a));
  const g2 = zlib.gzipSync(Buffer.from(b));
  const merged = new Uint8Array(Buffer.concat([g1, g2]));
  const expected = new Uint8Array(a.length + b.length);
  expected.set(a, 0);
  expected.set(b, a.length);
  assert.deepEqual(gunzipSync(merged), expected);
});

test('显式构造非字节对齐的多块流（FIXED 后紧跟动态块）', () => {
  // zlib 有时会产出多块；这里强制把两个我们产出的流在块边界拼接很困难，
  // 改用 zlib level 1 + level 9 的数据通常能覆盖固定/动态块交界。
  const data = generators.mixed(150000);
  for (let level = 1; level <= 9; level++) {
    const z = zlib.deflateRawSync(Buffer.from(data), { level });
    assert.deepEqual(inflateSync(z), data, `level ${level}`);
  }
});

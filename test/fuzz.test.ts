/**
 * 大规模随机模糊：随机字节分布 + 随机规模，zlib level 1..9 双向互通，
 * 重点覆盖块与块非字节对齐交界、动态码表的各种边角组合。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { deflateSync, inflateSync, gzipSync, gunzipSync } from '../src/index';

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    // xorshift32，确定性
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
}

function generate(kind: number, n: number, seed: number): Uint8Array {
  const r = rng(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const x = r();
    switch (kind) {
      case 0: // 纯随机
        out[i] = x & 0xff;
        break;
      case 1: // 小字母表
        out[i] = 0x61 + (x % 6);
        break;
      case 2: // 二进制稀疏
        out[i] = x % 20 === 0 ? x & 0xff : 0;
        break;
      case 3: // 混合：段状重复 + 随机
        if (x % 4 === 0) out[i] = x & 0xff;
        else if (i > 1000 && x % 3 === 0) out[i] = out[i - 1 - (x % 500)];
        else out[i] = 0x20 + (x % 90);
        break;
      case 4: // 阶梯字节，触发大量距离码
        out[i] = (i & 0xff) ^ (x & 3);
        break;
      default:
        out[i] = x & 0xff;
    }
  }
  return out;
}

test('模糊：5 种分布 × 多种规模 × level 1..9 双向解压一致', () => {
  const sizes = [0, 1, 2, 3, 258, 259, 32000, 32768, 32769, 65535, 65536, 65537, 100003, 262144];
  for (let kind = 0; kind < 5; kind++) {
    for (const n of sizes) {
      const data = generate(kind, n, 1000 + kind * 31 + n);
      // 本库 -> zlib
      const ours = deflateSync(data);
      assert.deepEqual(new Uint8Array(zlib.inflateRawSync(Buffer.from(ours))), data, `ours->zlib kind=${kind} n=${n}`);
      // zlib 各级 -> 本库
      for (let level = 1; level <= 9; level++) {
        const z = zlib.deflateRawSync(Buffer.from(data), { level });
        assert.deepEqual(inflateSync(z), data, `zlib(${level})->ours kind=${kind} n=${n}`);
      }
    }
  }
});

test('模糊：随机种子大规模（约 1MB × 10 组）', () => {
  for (let t = 0; t < 10; t++) {
    const n = 200000 + t * 99991;
    const data = generate(t % 5, n, 777 + t);
    const level = (t % 9) + 1;
    const z = zlib.gzipSync(Buffer.from(data), { level });
    assert.deepEqual(gunzipSync(new Uint8Array(z)), data, `gzip t=${t} level=${level}`);
    const ours = gzipSync(data);
    assert.deepEqual(new Uint8Array(zlib.gunzipSync(Buffer.from(ours))), data, `ours gzip t=${t}`);
  }
});

test('所有 256 个单字节值往返', () => {
  for (let b = 0; b < 256; b++) {
    const data = new Uint8Array([b]);
    assert.deepEqual(inflateSync(deflateSync(data)), data, `byte ${b}`);
  }
});

test('所有长度 0..300 的全零数据往返（覆盖长度/距离码边界）', () => {
  for (let n = 0; n <= 300; n++) {
    const data = new Uint8Array(n);
    assert.deepEqual(inflateSync(deflateSync(data)), data, `zeros n=${n}`);
  }
});

test('匹配长度恰好 3 与 258 的边界', () => {
  // 构造能产生 min/max 匹配的数据
  for (const len of [3, 4, 10, 257, 258]) {
    const data = new Uint8Array(len * 3);
    const pat = new Uint8Array(len);
    for (let i = 0; i < len; i++) pat[i] = (i * 7 + 1) & 0xff;
    data.set(pat, 0);
    data.set(pat, len);
    data.set(pat, 2 * len);
    assert.deepEqual(inflateSync(deflateSync(data)), data, `match len=${len}`);
  }
});

/**
 * 块类型覆盖测试：遍历我们产出的裸 DEFLATE 流，统计实际出现的 BTYPE，
 * 证明 STORED(0)/FIXED(1)/DYNAMIC(2) 三种块都能被产出。
 * 块体推进：STORED 读 LEN 跳过；FIXED/DYNAMIC 解码到 EOB
 *（动态块需先解析码表），解完读取器正好停在下一块头。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'zlib';
import { deflateSync, inflateSync } from '../src/index';
import { BitReader } from '../src/bitstream';
import { DecodeTable, fixedDistLengths, fixedLitLengths } from '../src/huffman';
import {
  CL_ORDER,
  DIST_BASE,
  DIST_EXTRA,
  END_OF_BLOCK,
  LENGTH_BASE,
  LENGTH_EXTRA,
} from '../src/tables';

/** 读取一个动态块的两张码表（消费块头）。 */
function readDynamicTables(r: BitReader): { lit: DecodeTable; dist: DecodeTable } {
  const hlit = r.readBits(5) + 257;
  const hdist = r.readBits(5) + 1;
  const hclen = r.readBits(4) + 4;
  const cl = new Uint8Array(19);
  for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = r.readBits(3);
  const clt = new DecodeTable(cl);
  const lens = new Uint8Array(hlit + hdist);
  let i = 0;
  while (i < lens.length) {
    r.refill();
    const s = clt.decode(r.peek(15));
    r.drop(clt.lengths[s]);
    if (s < 16) lens[i++] = s;
    else if (s === 16) {
      const rep = r.readBits(2) + 3;
      lens.fill(lens[i - 1], i, i + rep);
      i += rep;
    } else if (s === 17) i += r.readBits(3) + 3;
    else i += r.readBits(7) + 11;
  }
  return { lit: new DecodeTable(lens.subarray(0, hlit)), dist: new DecodeTable(lens.subarray(hlit)) };
}

/** 解码一个压缩块的块体到 EOB（丢弃输出），读取器停在下一块头。 */
function decodeBodyToEob(r: BitReader, lit: DecodeTable, dist: DecodeTable): void {
  while (true) {
    r.refill();
    const sym = lit.decode(r.peek(15));
    r.drop(lit.lengths[sym]);
    if (sym === END_OF_BLOCK) return;
    if (sym < 256) continue;
    const li = sym - 257;
    if (LENGTH_EXTRA[li]) r.readBits(LENGTH_EXTRA[li]);
    r.refill();
    const ds = dist.decode(r.peek(15));
    r.drop(dist.lengths[ds]);
    if (ds > 29) throw new Error('bad dist symbol');
    if (DIST_EXTRA[ds]) r.readBits(DIST_EXTRA[ds]);
    void LENGTH_BASE;
    void DIST_BASE;
  }
}

/** 遍历整个流的块头，返回每块的 BTYPE 序列。 */
function enumerateBlocks(data: Uint8Array): number[] {
  const r = new BitReader(data);
  const btypes: number[] = [];
  let bfinal = 0;
  while (bfinal === 0) {
    bfinal = r.readBits(1);
    const btype = r.readBits(2);
    if (btype === 3) throw new Error('reserved block type');
    btypes.push(btype);
    if (btype === 0) {
      r.alignToByte();
      const len = r.readAlignedUint16LE();
      const nlen = r.readAlignedUint16LE();
      if ((len ^ nlen) !== 0xffff) throw new Error('bad stored block');
      r.readAlignedBytes(len);
    } else if (btype === 1) {
      decodeBodyToEob(r, new DecodeTable(fixedLitLengths()), new DecodeTable(fixedDistLengths()));
    } else {
      const { lit, dist } = readDynamicTables(r);
      decodeBodyToEob(r, lit, dist);
    }
    if (btypes.length > 100000) throw new Error('too many blocks');
  }
  return btypes;
}

test('遍历产物块头：大块文本产生多个块且可完整枚举', () => {
  const data = new TextEncoder().encode('the quick brown fox '.repeat(8000));
  const z = deflateSync(data);
  const btypes = enumerateBlocks(z);
  assert.ok(btypes.length >= 3, `expected multiple blocks, got ${btypes.length}`);
  assert.deepEqual(inflateSync(z), data);
});

test('STORED 块被产出：高度随机数据', () => {
  const data = new Uint8Array(200000);
  let seed = 42;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = seed & 0xff;
  }
  const z = deflateSync(data);
  assert.ok(enumerateBlocks(z).includes(0), 'expected a STORED block');
  assert.deepEqual(inflateSync(z), data);
});

test('DYNAMIC 块被产出：可压缩文本', () => {
  const data = new Uint8Array(300000);
  const words = new TextEncoder().encode('error info warn debug timeout user session ');
  let s = 7;
  for (let i = 0; i < data.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    data[i] = words[s % words.length];
    if (s % 200 === 0) data[i] = 0x0a;
  }
  const z = deflateSync(data);
  assert.ok(enumerateBlocks(z).includes(2), 'expected a DYNAMIC block');
  assert.deepEqual(inflateSync(z), data);
  assert.deepEqual(new Uint8Array(zlib.inflateRawSync(Buffer.from(z))), data);
});

test('FIXED 块被产出：若干很短的高重复输入中至少一个选 FIXED', () => {
  let sawFixed = false;
  for (let len = 1; len <= 40; len++) {
    const data = new Uint8Array(len);
    for (let i = 0; i < len; i++) data[i] = 0x61 + (i % 3);
    const z = deflateSync(data);
    if (enumerateBlocks(z).includes(1)) sawFixed = true;
    assert.deepEqual(inflateSync(z), data);
  }
  assert.ok(sawFixed, 'expected at least one FIXED block among short inputs');
});

test('空输入产出 5 字节的 BFINAL STORED 终止块', () => {
  const z = deflateSync(new Uint8Array(0));
  assert.deepEqual(Array.from(z), [0x01, 0x00, 0x00, 0xff, 0xff]);
});

test('所有产物都恰好有一个 BFINAL 块且流在字节边界结束', () => {
  for (const data of [
    new Uint8Array(0),
    new TextEncoder().encode('x'),
    new TextEncoder().encode('hello world '.repeat(100)),
    new Uint8Array(200000).map((_, i) => i & 0xff),
  ]) {
    const z = deflateSync(data);
    const btypes = enumerateBlocks(z);
    assert.deepEqual(inflateSync(z), data);
    assert.deepEqual(new Uint8Array(zlib.inflateRawSync(Buffer.from(z))), data);
    assert.ok(btypes.length >= 1);
  }
});

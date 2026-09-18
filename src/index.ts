/**
 * seekzip —— 自带跳转索引的 gzip/DEFLATE 编解码库。
 *
 * 四组对外接口：
 *   压缩：       deflateSync / gzipSync / Deflater / GzipDeflater
 *   解压：       inflateSync / gunzipSync / Inflater
 *   带索引压缩： gzipSyncIndexed / GzipDeflater({seekInterval})
 *   按区间解压： gunzipRangeSync / gunzipRange
 *
 * 实现全部在本库内（含 DEFLATE 与 CRC32），不依赖任何第三方压缩库，
 * 也不调用 node:zlib。
 */

import { BitReader, BitWriter, ByteSink } from './bitstream';
import { Deflater, DeflaterOptions, SeekEntry } from './deflate';
import { Inflater } from './inflate';
import { GzipDeflater, gunzipSync, gzipSync } from './gzip';
import {
  findSpan,
  gzipSyncIndexed,
  gunzipRange,
  gunzipRangeSync,
  parseIndex,
  serializeIndex,
  coveringByteRange,
  IndexedGzip,
  RandomAccessReader,
  SeekIndex,
} from './seek';

/** 原始 DEFLATE 压缩（无 gzip 容器）。 */
export function deflateSync(input: Uint8Array, options?: DeflaterOptions): Uint8Array {
  const bw = new BitWriter();
  const def = new Deflater(bw, options);
  def.write(input);
  def.finish();
  return bw.sink.toBytes();
}

/** 原始 DEFLATE 解压（无 gzip 容器）。 */
export function inflateSync(input: Uint8Array): Uint8Array {
  const reader = new BitReader(input, 0, input.length);
  return new Inflater(reader).run();
}

export {
  // gzip 容器
  gzipSync,
  gunzipSync,
  GzipDeflater,
  // 流处理类
  Deflater,
  Inflater,
  // 带索引压缩
  gzipSyncIndexed,
  // 按区间解压
  gunzipRangeSync,
  gunzipRange,
  // 索引工具
  serializeIndex,
  parseIndex,
  findSpan,
  coveringByteRange,
};

export type {
  DeflaterOptions,
  SeekEntry,
  SeekIndex,
  IndexedGzip,
  RandomAccessReader,
};

export { ByteSink };

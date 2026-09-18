/**
 * gzip 容器封装（RFC 1952）。
 *
 * 压缩：固定 10 字节基本头（无 FNAME/FEXTRA 等字段，MTIME=0、
 * XFL/OS 按 zlib 惯例填写）+ DEFLATE 流 + 8 字节尾
 * （CRC32、原始长度 mod 2^32）。
 *
 * 解压：容忍带可选字段（FEXTRA/FNAME/FCOMMENT/FHCRC）的头部，
 * 校验 CRC32 与 ISIZE，多段成员（concatenated members）顺序拼接。
 */

import { BitReader } from './bitstream';
import { BitWriter, ByteSink } from './bitstream';
import { crc32, crc32Update } from './crc32';
import { Deflater, DeflaterOptions } from './deflate';
import { Inflater } from './inflate';

const GZIP_MAGIC0 = 0x1f;
const GZIP_MAGIC1 = 0x8b;
const DEFLATE_CM = 8;
const FEXTRA = 4;
const FNAME = 8;
const FCOMMENT = 16;
const FHCRC = 2;

export interface GzipCompressOptions extends DeflaterOptions {}

/** gzip 压缩（单成员，CRC 与 ISIZE 正确）。 */
export function gzipSync(input: Uint8Array, options: GzipCompressOptions = {}): Uint8Array {
  const sink = new ByteSink();
  writeGzipHeader(sink);

  const bw = new BitWriter(sink);
  const def = new Deflater(bw, options);
  def.write(input);
  def.finish();

  sink.writeUint32LE(crc32(input));
  sink.writeUint32LE(input.length >>> 0);
  return sink.toBytes();
}

/**
 * 流式 gzip 压缩器：适合分块写入大文件。
 * finish() 返回完整 gzip 字节（内存中仍持有全部压缩结果）。
 */
export class GzipDeflater {
  private sink = new ByteSink();
  private deflater: Deflater;
  private crc = 0;
  private rawLen = 0;
  private finished = false;
  readonly deflateOffset = 10; // 基本头长度，DEFLATE 流起点

  constructor(options: GzipCompressOptions = {}) {
    writeGzipHeader(this.sink);
    this.deflater = new Deflater(new BitWriter(this.sink), options);
  }

  get seekIndex() {
    return this.deflater.index;
  }

  write(chunk: Uint8Array): void {
    if (this.finished) throw new Error('GzipDeflater already finished');
    this.deflater.write(chunk);
    this.crc = crc32Update(this.crc, chunk);
    this.rawLen += chunk.length;
  }

  finish(): Uint8Array {
    if (this.finished) return this.sink.toBytes();
    this.deflater.finish();
    this.sink.writeUint32LE(this.crc >>> 0);
    this.sink.writeUint32LE(this.rawLen >>> 0);
    this.finished = true;
    return this.sink.toBytes();
  }
}

function writeGzipHeader(sink: ByteSink): void {
  sink.writeByte(GZIP_MAGIC0);
  sink.writeByte(GZIP_MAGIC1);
  sink.writeByte(DEFLATE_CM); // CM=8 (deflate)
  sink.writeByte(0); // FLG=0
  sink.writeUint32LE(0); // MTIME=0
  sink.writeByte(0); // XFL=0
  sink.writeByte(0xff); // OS=255 (unknown)，与 zlib 默认一致
}

/** gunzip：支持可选头字段与多成员拼接，校验 CRC32 和 ISIZE。 */
export function gunzipSync(data: Uint8Array): Uint8Array {
  let offset = 0;
  const parts: Uint8Array[] = [];
  while (offset < data.length) {
    const member = inflateOneMember(data, offset);
    parts.push(member.out);
    offset = member.nextOffset;
  }
  if (parts.length === 1) return parts[0];
  const total = parts.reduce((a, p) => a + p.length, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    merged.set(p, off);
    off += p.length;
  }
  return merged;
}

function inflateOneMember(data: Uint8Array, start: number): { out: Uint8Array; nextOffset: number } {
  if (start + 18 > data.length || data[start] !== GZIP_MAGIC0 || data[start + 1] !== GZIP_MAGIC1) {
    throw new Error('not a valid gzip member: bad magic');
  }
  if (data[start + 2] !== DEFLATE_CM) throw new Error('unsupported gzip compression method');
  const flg = data[start + 3];

  let p = start + 10;
  if (flg & FEXTRA) {
    if (p + 2 > data.length) throw new Error('truncated gzip FEXTRA');
    const xlen = data[p] | (data[p + 1] << 8);
    p += 2 + xlen;
  }
  if (flg & FNAME) {
    while (p < data.length && data[p] !== 0) p++;
    p++;
  }
  if (flg & FCOMMENT) {
    while (p < data.length && data[p] !== 0) p++;
    p++;
  }
  if (flg & FHCRC) p += 2;
  if (p + 8 > data.length) throw new Error('truncated gzip member header');

  // DEFLATE 部分以字节为起点，但块交界不一定对齐，交给 BitReader
  const reader = new BitReader(data, p, data.length);
  const inflater = new Inflater(reader);
  const out = inflater.run();
  // 逻辑流位置按比特计；最终块结束（BFINAL）时读取器恰好停在
  // 字节边界（我们产出的流和 zlib 的流都在 STORED/补齐后对齐），
  // consumedBytes 即 DEFLATE 数据结束字节。
  const deflateEnd = p + reader.consumedBytes;

  if (deflateEnd + 8 > data.length) throw new Error('truncated gzip trailer');
  const crcStored = readUint32LE(data, deflateEnd);
  const sizeStored = readUint32LE(data, deflateEnd + 4);
  const crcComputed = crc32(out);
  if (crcComputed !== crcStored) {
    throw new Error(`gzip CRC32 mismatch: stored ${crcStored >>> 0}, computed ${crcComputed}`);
  }
  if ((out.length >>> 0) !== sizeStored) {
    throw new Error('gzip ISIZE mismatch');
  }
  return { out, nextOffset: deflateEnd + 8 };
}

function readUint32LE(data: Uint8Array, off: number): number {
  return (
    (data[off] |
      (data[off + 1] << 8) |
      (data[off + 2] << 16) |
      (data[off + 3] << 24)) >>>
    0
  );
}

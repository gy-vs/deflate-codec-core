/**
 * gzip decompression: parse each member header, inflate the raw DEFLATE body,
 * and verify the CRC-32 and ISIZE footer. Concatenated members are supported.
 */
import { Crc32 } from '../util/crc32.js';
import { ArraySink, inflateRawStream } from '../deflate/inflate.js';
import { gzipHeaderLength, GZIP_MAGIC_0, GZIP_MAGIC_1 } from './gzip.js';

/** Decompress a gzip stream (single or concatenated members) and verify CRC. */
export function gunzip(input: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let offset = 0;

  while (offset < input.length) {
    if (input.length - offset < 18) throw new Error('truncated gzip member');
    if (input[offset] !== GZIP_MAGIC_0 || input[offset + 1] !== GZIP_MAGIC_1) {
      throw new Error('bad gzip magic');
    }
    const headerLen = gzipHeaderLength(input.subarray(offset));
    const bodyOffset = offset + headerLen;

    const sink = new ArraySink();
    const { bytesConsumed } = inflateRawStream(input.subarray(bodyOffset), sink);
    const produced = sink.toUint8Array();

    const footer = bodyOffset + bytesConsumed;
    if (footer + 8 > input.length) throw new Error('missing gzip footer');
    const crcStored =
      (input[footer] | (input[footer + 1] << 8) |
        (input[footer + 2] << 16) | (input[footer + 3] << 24)) >>> 0;
    const sizeStored =
      (input[footer + 4] | (input[footer + 5] << 8) |
        (input[footer + 6] << 16) | (input[footer + 7] << 24)) >>> 0;

    if (Crc32.oneShot(produced) !== crcStored) throw new Error('gzip CRC-32 mismatch');
    if ((produced.length >>> 0) !== sizeStored) throw new Error('gzip ISIZE mismatch');

    chunks.push(produced);
    total += produced.length;
    offset = footer + 8;
  }

  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

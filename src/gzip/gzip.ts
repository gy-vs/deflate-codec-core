/**
 * gzip container (RFC 1952) wrapping a raw DEFLATE stream.
 *
 * Layout:
 *   10-byte header (ID1 ID2 CM FLG MTIME XFL OS), optional FNAME/FEXTRA/FCOMMENT
 *   sections when flags request them, then the DEFLATE body, then an 8-byte
 *   footer (CRC-32 and ISIZE, both little-endian).
 *
 * The downstream teams use gunzip, so only the widely supported header fields
 * are produced. FLG is kept 0 unless a filename is supplied.
 */
import { Crc32 } from '../util/crc32.js';

export const GZIP_MAGIC_0 = 0x1f;
export const GZIP_MAGIC_1 = 0x8b;
export const CM_DEFLATE = 8;
const FNAME = 0x08;

export interface GzipHeaderOptions {
  /** Optional ISO-8859-1 file name written to the FNAME header field. */
  fileName?: string;
  /** Modification time, Unix epoch seconds (0 = omitted). */
  mtime?: number;
  /** XFL: 2 = maximum compression, 4 = fastest. */
  extraFlags?: number;
}

export interface GzipParts {
  header: Uint8Array;
  deflate: Uint8Array;
  crc32: number;
  originalSize: number;
}

/** Build the gzip header bytes (no FEXTRA/FCOMMENT; optional FNAME). */
export function buildGzipHeader(options: GzipHeaderOptions = {}): Uint8Array {
  const fileName = options.fileName;
  const mtime = options.mtime ?? 0;
  const extraFlags = options.extraFlags ?? 0;
  const flg = fileName ? FNAME : 0;

  const nameBytes: number[] = [];
  if (fileName) {
    for (let i = 0; i < fileName.length; i++) {
      nameBytes.push(fileName.charCodeAt(i) & 0xff);
    }
    nameBytes.push(0); // NUL terminator
  }

  const out = new Uint8Array(10 + nameBytes.length);
  out[0] = GZIP_MAGIC_0;
  out[1] = GZIP_MAGIC_1;
  out[2] = CM_DEFLATE;
  out[3] = flg;
  out[4] = mtime & 0xff;
  out[5] = (mtime >>> 8) & 0xff;
  out[6] = (mtime >>> 16) & 0xff;
  out[7] = (mtime >>> 24) & 0xff;
  out[8] = extraFlags;
  out[9] = 0xff; // OS = unknown
  out.set(nameBytes, 10);
  return out;
}

/** Assemble a complete gzip member from header + raw deflate + original bytes. */
export function buildGzip(
  header: Uint8Array,
  deflate: Uint8Array,
  original: Uint8Array,
): Uint8Array {
  const crc = Crc32.oneShot(original);
  const size = original.length >>> 0;
  const out = new Uint8Array(header.length + deflate.length + 8);
  out.set(header, 0);
  out.set(deflate, header.length);
  const f = header.length + deflate.length;
  out[f + 0] = crc & 0xff;
  out[f + 1] = (crc >>> 8) & 0xff;
  out[f + 2] = (crc >>> 16) & 0xff;
  out[f + 3] = (crc >>> 24) & 0xff;
  out[f + 4] = size & 0xff;
  out[f + 5] = (size >>> 8) & 0xff;
  out[f + 6] = (size >>> 16) & 0xff;
  out[f + 7] = (size >>> 24) & 0xff;
  return out;
}

/** Parse just enough of a gzip header to return the byte offset of DEFLATE. */
export function gzipHeaderLength(input: Uint8Array): number {
  if (input.length < 10 || input[0] !== GZIP_MAGIC_0 || input[1] !== GZIP_MAGIC_1) {
    throw new Error('not a gzip stream (bad magic)');
  }
  if (input[2] !== CM_DEFLATE) throw new Error('unsupported compression method');
  const flg = input[3];
  let offset = 10;
  if (flg & 0x04) {
    // FEXTRA: XLEN + that many bytes
    const xlen = input[offset] | (input[offset + 1] << 8);
    offset += 2 + xlen;
  }
  if (flg & 0x08) {
    while (input[offset] !== 0) offset++;
    offset++;
  }
  if (flg & 0x10) {
    while (input[offset] !== 0) offset++;
    offset++;
  }
  if (flg & 0x02) offset += 2; // FHCRC
  return offset;
}

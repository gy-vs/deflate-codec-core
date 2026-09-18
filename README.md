# gzip-seek

A from-scratch, seekable gzip/DEFLATE codec written in TypeScript for Node.js 20.
No third-party compression libraries are used; the only DEFLATE/gzip code is in
`src/`. Node's `node:zlib` appears **only** in tests and benchmarks as an
independent reference implementation.

## What it does

- **Hand-written DEFLATE** (`src/deflate`): 3-byte sliding-window LZ77 with hash
  chains and lazy matching, canonical length-limited Huffman codes, and all
  three block types — stored, fixed-Huffman and dynamic-Huffman. The
  decompressor accepts any legal DEFLATE stream, including non-byte-aligned
  block boundaries.
- **Standard gzip container** (`src/gzip`): correct header fields, CRC-32 and
  ISIZE footer. Output is plain gzip that `gunzip`/`zcat` consume directly.
- **Seekable compression**: every N original bytes the current block is closed
  and the sliding window reset, and an index records each block's
  `(uncompressed offset, compressed bit offset)`. Any block is independently
  decodable, so a byte range needs only the blocks that cover it.

## Install / build / test

```bash
npm install
npm run build     # tsc -> dist/
npm test          # build tests, then node:test (zlib is used here only as reference)
npm run tradeoff  # compression-ratio vs seek-granularity table
```

## Library API

```ts
import {
  gzip, gunzip,                 // standard gzip
  deflate, inflate,             // raw DEFLATE
  compressSeekable,             // gzip + index with a configurable seek interval
  inflateRange,                 // decompress just a byte range
  serializeIndex, deserializeIndex,
} from './dist/index.js';

const gz = gzip(data);                         // standard gzip bytes
const back = gunzip(gz);                       // CRC + length verified

const { gzip: seekGz, deflate, index } =
  compressSeekable(data, 131072);              // independent block every 128 KiB

const slice = inflateRange(deflate, index, 5_000_000, 5_002_000);
// only the blocks overlapping the range were decompressed

// The index serializes to JSON for sidecar storage.
await fs.writeFile('log.gz.idx', JSON.stringify(serializeIndex(index)));
```

`compressSeekable` produces a fully standard `.gz`; the index is a separate
sidecar. Downstream teams can ignore the index and use ordinary `gunzip`.

## Block-boundary semantics

Block headers are packed LSB-first and are generally **not** byte aligned
(stored blocks are the exception). The index stores bit offsets, and ranged
decompression positions a bit reader at the exact boundary, so no block is
skipped or duplicated.

## Performance / ratio

On log-like data at level 6 the compressor is within a few percent of zlib -6
(often slightly smaller) when no seek points are used, at single-digit-MB/s in
plain JS — comfortably under the 1 GB / 10 minute budget. Resetting the window
for seek points trades ratio for granularity; run `npm run tradeoff` to see the
curve (a 128 KiB interval costs only a few percent while making any ~128 KiB
neighborhood independently fetchable).

## Layout

```
src/deflate/  tables, bit reader/writer, Huffman, code-length construction,
               LZ77 matcher, block encoder, decompressor, orchestration
src/gzip/     gzip header/footer assembly and CRC-verified gunzip
src/seek/     seek index and ranged decompression
src/util/     bit I/O and CRC-32
test/         node:test suite (zlib reference, byte-exact round trips, edges)
```

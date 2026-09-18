# seekzip

自带**跳转索引**的 gzip/DEFLATE 编解码库，纯 TypeScript 实现，跑在 Node 20 上。
适用于每天一个、单个 2–8 GB 的归档日志：压缩时按可配置间隔埋下可独立解压的跳转点，
查询一条日志时只 Range 读取并解压覆盖目标区间的那几段，而不是下载整文件从头解。

- DEFLATE（RFC 1951）压缩器**从零实现**：32K 滑动窗口哈希链匹配、lazy matching、
  长度/距离与游程编码、规范 Huffman 码（package-merge，码长 ≤15）。
  STORED / FIXED / DYNAMIC 三种块都能产出，逐块按精确比特成本自选。
- DEFLATE 解压器能吃下**任意合法流**（不只是本库产物），两级查表解码，
  已用 Node 自带 zlib 的 level 1–9 双向互通验证。
- 外层 gzip（RFC 1952）：正确的头字段、CRC32、ISIZE；能解析带 FNAME/FEXTRA/
  FCOMMENT/FHCRC 的头和多成员拼接。产物是标准 gzip，下游可直接 `gunzip`。
- 可配置跳转间隔 + 索引（原始偏移 ↔ 压缩流位偏移），按原始偏移区间只解压相关跨度。
- **不依赖任何第三方压缩库**（无 pako/fflate/zlib-js/…），实现代码不调用 `node:zlib`；
  `node:zlib` 只出现在测试里做对照。

## 安装与构建

```bash
npm install
npm run build   # tsc -> dist/
npm test        # tsc + node --test dist/test/
npm run bench    # node dist/benchmarks/realistic.js [字节数]
```

## 对外接口

```ts
import {
  // 压缩
  deflateSync, gzipSync, Deflater, GzipDeflater,
  // 解压
  inflateSync, gunzipSync, Inflater,
  // 带索引压缩
  gzipSyncIndexed,
  // 按区间解压
  gunzipRangeSync, gunzipRange, coveringByteRange,
  // 索引工具 / 类型
  serializeIndex, parseIndex, findSpan,
} from 'seekzip';
```

### 压缩 / 解压

```ts
const gz: Uint8Array = gzipSync(rawBytes);
const back: Uint8Array = gunzipSync(gz);

// 裸 DEFLATE（无 gzip 容器）
const raw = deflateSync(data);
const out = inflateSync(raw);

// 流式（适合 GB 级分块喂入，内存占用约为窗口 + 当前块）
const g = new GzipDeflater();
g.write(chunk1); g.write(chunk2);
const bytes = g.finish();
```

### 带索引压缩

```ts
const { data, index } = gzipSyncIndexed(rawBytes, /*interval*/ 1 << 20);
// data  仍是标准 gzip
// index 记录每个跳转点的 rawOffset 与 DEFLATE 流内 bitOffset
const indexJson = serializeIndex(index);   // 持久化到对象存储元数据/旁路文件
```

`interval` 是原始字节粒度：每累计这么多字节就强制收尾当前块、**重置滑动窗口**
另起一块并记录索引点。跨边界的匹配会被切开，因此每个跨度独立可解。
重置窗口会牺牲压缩率，间隔越小牺牲越多（见下表）。

### 按区间解压

数据已在内存：

```ts
const slice = gunzipRangeSync(gzipBytes, index, startRaw, endRaw);
// 长度恰为 endRaw - startRaw，逐字节等于 rawBytes.subarray(startRaw, endRaw)
```

数据在对象存储（只 Range GET 需要的字节，单次请求）：

```ts
class S3Reader implements RandomAccessReader {
  constructor(private key: string) {}
  async size() { /* HEAD 对象大小 */ }
  async read(offset: number, length: number) { /* GET Range: bytes=offset-(offset+length-1) */ }
}

// 也可以先用 coveringByteRange(index, start, end) 自行规划 Range
const slice = await gunzipRange(new S3Reader(key), index, startRaw, endRaw);
```

## 压缩率 / 跳转粒度取舍

在约 50 MB 仿真日志语料上实测（Node 20）：

| interval | 压缩后 | 压缩率 | 相对 zlib -6 | 最大跳转粒度（最坏多读的原始量） |
|---------:|-------:|-------:|-------------:|-------------------------------:|
| 8 KiB    | 5.29 MB | 0.111 | 2.15× | 8 KiB |
| 32 KiB   | 3.56 MB | 0.075 | 1.45× | 32 KiB |
| 128 KiB  | 2.77 MB | 0.058 | 1.13× | 128 KiB |
| 512 KiB  | 2.55 MB | 0.054 | 1.04× | 512 KiB |
| 2 MiB    | 2.50 MB | 0.052 | 1.02× | 2 MiB |
| 不设跳转点 | 2.48 MB | 0.052 | **1.01×** | 整文件 |

- 不设跳转点时体积约为 zlib level 6 的 **1.01×**（要求 ≤1.05，达标）。
- 压缩吞吐约 15–21 MB/s（取决于语料），外推 1 GB 约 **0.8–1.2 分钟**（要求 <10 分钟）。
- 512 KiB–2 MiB 的间隔通常是查询时延与压缩率的甜点：最坏多解压几百 KB，
  体积损失只有 2–4%。

## 目录结构

```
src/
  tables.ts    RFC 1951 长度/距离码表与查反查表
  crc32.ts     CRC32（IEEE，增量）
  bitstream.ts LSB 位读写（支持非字节对齐块交界）
  huffman.ts   package-merge 码长、规范码、两级解码表
  deflate.ts   LZ77 滑动窗口 + 三种块产出 + 跳转跨度/索引
  inflate.ts   任意合法 DEFLATE 流解码（32K ring 处理重叠距离）
  gzip.ts      gzip 容器（压缩/解析、CRC、ISIZE、多成员）
  seek.ts      索引与按区间/随机读取解压
  index.ts     对外入口
test/          node:test（zlib 仅在此处作对照）
benchmarks/    压缩率与速度、间隔取舍
```

## 约定与边界

- 本库只做**库**，不提供命令行入口，也不内置服务端。
- 大文件请用 `GzipDeflater` 分块 `write()`；压缩端内存约为几百 KB 窗口/块缓冲，
  与输入总大小无关。
- ISIZE/长度按 32 位回绕语义处理（与 gzip 一致）。
- 解码损坏/截断/过订阅码表等非法流会抛错，不会静默产出错误数据。

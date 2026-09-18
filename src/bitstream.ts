/**
 * DEFLATE 位级输入输出。
 *
 * DEFLATE 按 LSB 优先打包（RFC 1951 §3.1.1）：多字节小端，
 * 每个数据元素从字节的最低位开始写。Huffman 码是个例外——
 * 码本身按 MSB 先出现，等价于把规范码逐位反转后按 LSB 写入，
 * 因此本模块只提供普通的 LSB writeBits，反转在构造码表时完成。
 */

/** 只增的字节缓冲，内部用 64KB 分块避免逐字节分配与大块拷贝。 */
export class ByteSink {
  private static readonly CHUNK = 1 << 16;
  private chunks: Uint8Array[] = [];
  private current = new Uint8Array(ByteSink.CHUNK);
  private curLen = 0;
  private bytesWritten = 0;

  get length(): number {
    return this.bytesWritten;
  }

  writeByte(v: number): void {
    if (this.curLen === this.current.length) {
      this.chunks.push(this.current);
      this.current = new Uint8Array(ByteSink.CHUNK);
      this.curLen = 0;
    }
    this.current[this.curLen++] = v & 0xff;
    this.bytesWritten++;
  }

  writeBytes(data: Uint8Array, start = 0, end = data.length): void {
    let off = start;
    while (off < end) {
      if (this.curLen === this.current.length) {
        this.chunks.push(this.current);
        this.current = new Uint8Array(ByteSink.CHUNK);
        this.curLen = 0;
      }
      const n = Math.min(end - off, this.current.length - this.curLen);
      this.current.set(data.subarray(off, off + n), this.curLen);
      this.curLen += n;
      off += n;
    }
    this.bytesWritten += end - start;
  }

  /** 小端写入 32 位无符号整数。 */
  writeUint32LE(v: number): void {
    this.writeByte(v & 0xff);
    this.writeByte((v >>> 8) & 0xff);
    this.writeByte((v >>> 16) & 0xff);
    this.writeByte((v >>> 24) & 0xff);
  }

  /** 拼接成单个 Uint8Array 返回。 */
  toBytes(): Uint8Array {
    const out = new Uint8Array(this.bytesWritten);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    out.set(this.current.subarray(0, this.curLen), off);
    return out;
  }
}

/**
 * LSB 优先的位写入器。
 *
 * 不变量：bitbuf 始终为无符号 32 位整数（>>> 0 维护），
 * 已写入但未满字节的比特占低 bitcnt 位；
 * 每次 writeBits 的 n <= 16，保证 value<<bitcnt 不超过 32 位
 * （bitcnt 上限 7，因每写一次至少把 1 字节排空到 sink）。
 */
export class BitWriter {
  readonly sink: ByteSink;
  private bitbuf = 0;
  private bitcnt = 0;
  private totalBits = 0;

  constructor(sink?: ByteSink) {
    this.sink = sink ?? new ByteSink();
  }

  /** 已写入流中的总比特数（含尚未排空的尾部比特）。 */
  get bitOffset(): number {
    return this.totalBits;
  }

  /** 写入低 n 位（n <= 16），按 LSB 先打包。 */
  writeBits(value: number, n: number): void {
    this.bitbuf = (this.bitbuf + ((value & ((1 << n) - 1)) << this.bitcnt)) >>> 0;
    this.bitcnt += n;
    this.totalBits += n;
    while (this.bitcnt >= 8) {
      this.sink.writeByte(this.bitbuf & 0xff);
      this.bitbuf >>>= 8;
      this.bitcnt -= 8;
    }
  }

  /**
   * 对齐到下一字节边界：不足 8 位的部分补 0。
   * STORED 块的头部必须从字节边界开始。
   */
  alignToByte(): void {
    if (this.bitcnt > 0) {
      this.sink.writeByte(this.bitbuf & 0xff);
      this.totalBits += 8 - this.bitcnt;
      this.bitbuf = 0;
      this.bitcnt = 0;
    }
  }

  /** 块内逐字节写入 LEN 字节原始数据（调用前必须已对齐）。 */
  writeAlignedBytes(data: Uint8Array, start: number, end: number): void {
    if (this.bitcnt !== 0) throw new Error('writeAlignedBytes requires byte alignment');
    this.sink.writeBytes(data, start, end);
    this.totalBits += (end - start) * 8;
  }

  writeAlignedUint16LE(v: number): void {
    if (this.bitcnt !== 0) throw new Error('writeAlignedUint16LE requires byte alignment');
    this.sink.writeByte(v & 0xff);
    this.sink.writeByte((v >>> 8) & 0xff);
    this.totalBits += 16;
  }

  writeAlignedUint32LE(v: number): void {
    if (this.bitcnt !== 0) throw new Error('writeAlignedUint32LE requires byte alignment');
    this.sink.writeUint32LE(v);
    this.totalBits += 32;
  }
}

/**
 * LSB 优先的位读取器，基于一段确定的字节区间。
 * 同步全量解压和区间解压（区间数据预取后）都用它。
 */
export class BitReader {
  private readonly data: Uint8Array;
  private readonly start: number;
  private readonly end: number;
  private pos: number;
  private bitbuf = 0;
  private bitcnt = 0;

  constructor(data: Uint8Array, start = 0, end = data.length) {
    this.data = data;
    this.start = start;
    this.end = end;
    this.pos = start;
  }

  /** 当前流位置（比特数），用于从索引的位偏移处起跳。 */
  get bitPosition(): number {
    return (this.pos - this.start) * 8 - this.bitcnt;
  }

  /** 剩余可提供的比特总数（含缓冲区中已有的）。 */
  get availableBits(): number {
    return this.bitcnt + (this.end - this.pos) * 8;
  }

  get bytePosition(): number {
    return this.pos;
  }

  get isByteAligned(): boolean {
    return this.bitcnt === 0;
  }

  /**
   * 跳过开头 n 个比特。供跳转使用：先把读取器定位到包含
   * 目标位偏移的字节，再 skipBits 处理字节内偏移。
   */
  skipBits(n: number): void {
    const whole = n >>> 3;
    for (let i = 0; i < whole; i++) this.readBits(8);
    const rem = n & 7;
    if (rem > 0) this.readBits(rem);
  }

  private refillOne(): void {
    if (this.pos < this.end) {
      this.bitbuf = (this.bitbuf + (this.data[this.pos++] << this.bitcnt)) >>> 0;
      this.bitcnt += 8;
    }
  }

  /** 尽量把缓冲填满（最多到 32 位），EOF 时静默停止。 */
  refill(): void {
    while (this.bitcnt <= 24 && this.pos < this.end) this.refillOne();
  }

  /** 查看低 n 位但不移除（n <= 15）。调用前需 refill 保证位数。 */
  peek(n: number): number {
    return this.bitbuf & ((1 << n) - 1);
  }

  /** 移除 n 个已消费的比特，并继续补充。 */
  drop(n: number): void {
    this.bitbuf >>>= n;
    this.bitcnt -= n;
    this.refill();
  }

  /** 读取 n 位（n <= 16，用于附加比特和块头字段）。 */
  readBits(n: number): number {
    if (this.availableBits < n) throw new Error('unexpected end of DEFLATE stream');
    this.refill();
    const v = this.bitbuf & ((1 << n) - 1);
    this.bitbuf >>>= n;
    this.bitcnt -= n;
    return v >>> 0;
  }

  /**
   * 丢弃到下一字节边界前的填充比特。
   * 缓冲中可能已预读了若干整字节：流位位置 = pos*8 - bitcnt，
   * 对齐只需丢掉当前这个不完整字节的零头（bitcnt % 8 位），
   * 已缓冲的整字节必须保留供后续按字节读取。
   */
  alignToByte(): void {
    const rem = this.bitcnt & 7;
    this.bitbuf >>>= rem;
    this.bitcnt -= rem;
  }

  /** 已消费的整字节数（向上取整到字节边界，相对读取起点）。 */
  get consumedBytes(): number {
    return (((this.pos - this.start) * 8 - this.bitcnt + 7) / 8) | 0;
  }

  /**
   * 对齐状态下读取 count 字节：先排空缓冲中已有的整字节，
   * 其余零拷贝切片。
   */
  private drainAligned(count: number): Uint8Array {
    const out = new Uint8Array(count);
    let i = 0;
    while (i < count && this.bitcnt >= 8) {
      out[i++] = this.bitbuf & 0xff;
      this.bitbuf >>>= 8;
      this.bitcnt -= 8;
    }
    if (i < count) {
      if (this.pos + (count - i) > this.end) {
        throw new Error('unexpected end of DEFLATE stream');
      }
      out.set(this.data.subarray(this.pos, this.pos + (count - i)), i);
      this.pos += count - i;
    }
    return out;
  }

  /** 对齐状态下读取一个字节。 */
  readAlignedByte(): number {
    if (this.bitcnt & 7) throw new Error('readAlignedByte requires byte alignment');
    if (this.bitcnt >= 8) {
      const v = this.bitbuf & 0xff;
      this.bitbuf >>>= 8;
      this.bitcnt -= 8;
      return v;
    }
    if (this.pos >= this.end) throw new Error('unexpected end of DEFLATE stream');
    return this.data[this.pos++];
  }

  /** 对齐状态下读取 16 位小端整数。 */
  readAlignedUint16LE(): number {
    if (this.bitcnt & 7) throw new Error('readAlignedUint16LE requires byte alignment');
    const b = this.drainAligned(2);
    return (b[0] | (b[1] << 8)) >>> 0;
  }

  /** 对齐状态下取出一段字节（STORED 块的原始数据）。 */
  readAlignedBytes(count: number): Uint8Array {
    if (this.bitcnt & 7) throw new Error('readAlignedBytes requires byte alignment');
    if (this.bitcnt > 0) return this.drainAligned(count);
    if (this.pos + count > this.end) throw new Error('unexpected end of DEFLATE stream');
    const slice = this.data.subarray(this.pos, this.pos + count);
    this.pos += count;
    return slice;
  }
}

/**
 * LSB-first bit writer used to emit DEFLATE streams.
 *
 * DEFLATE packs bits into bytes least-significant-bit first, and blocks are not
 * byte aligned with each other: only stored blocks (and a Huffman block's final
 * padding) align back to a byte boundary. This writer therefore keeps an
 * accumulator and lets block headers/tokens pack arbitrarily tightly.
 */
export class BitWriter {
  private buf: number[] = [];
  private acc = 0;
  private bits = 0;

  /**
   * Write the low `width` bits of `value`, LSB first. Width must be 1..16.
   * Invariant: before adding, fewer than 8 bits are buffered, so shifting a
   * <=16-bit value left by <=7 bits stays within 23 bits (no 32-bit overflow).
   */
  write(value: number, width: number): void {
    if (width === 0) return;
    // Keep at most 7 buffered bits so the shift below cannot overflow.
    if (this.bits >= 8) {
      const wholeBytes = this.bits >> 3;
      for (let i = 0; i < wholeBytes; i++) {
        this.buf.push(this.acc & 0xff);
        this.acc = this.acc >>> 8;
        this.bits -= 8;
      }
    }
    this.acc = ((this.acc | ((value & 0xffff) << this.bits)) >>> 0);
    this.bits += width;
    while (this.bits >= 8) {
      this.buf.push(this.acc & 0xff);
      this.acc = this.acc >>> 8;
      this.bits -= 8;
    }
  }

  /** Append raw bytes verbatim (caller guarantees the stream is byte aligned). */
  writeBytes(bytes: Uint8Array): void {
    if (this.bits !== 0) throw new Error('writeBytes requires byte alignment');
    for (let i = 0; i < bytes.length; i++) this.buf.push(bytes[i]);
  }

  /** Pad the partial byte with zero bits to the next byte boundary. */
  alignToByte(): void {
    if (this.bits > 0) {
      this.buf.push(this.acc & 0xff);
      this.acc = 0;
      this.bits = 0;
    }
  }

  /** Current position in the bit stream, including buffered bits. */
  get bitPosition(): number {
    return this.buf.length * 8 + this.bits;
  }

  /** Number of whole bytes emitted (buffered partial byte excluded). */
  get byteLength(): number {
    return this.buf.length;
  }

  /**
   * Finish and return the complete byte sequence, padding the final byte with
   * zero bits as DEFLATE requires after the final block.
   */
  finish(): Uint8Array {
    this.alignToByte();
    return Uint8Array.from(this.buf);
  }
}

/**
 * LSB-first bit reader over a DEFLATE stream.
 *
 * The accumulator is kept as an unsigned 32-bit value. Reads widen it one byte
 * at a time; callers never request more than 16 bits at once, and the decoder
 * refill ensures at least 16 bits are usually buffered so Huffman lookups can
 * be performed without per-bit refills.
 */
export class BitReader {
  readonly data: Uint8Array;
  private pos = 0;
  private acc = 0;
  private count = 0;

  constructor(data: Uint8Array, pos = 0) {
    this.data = data;
    this.pos = pos;
  }

  private refill(): void {
    // Buffer up to 32 bits. byte<<count overflows JS signed integers at
    // count >= 24, so accumulate with unsigned multiplication instead.
    while (this.count <= 24 && this.pos < this.data.length) {
      this.acc = (this.acc + Math.imul(this.data[this.pos++], 2 ** this.count)) >>> 0;
      this.count += 8;
    }
  }

  /** Read `n` bits (n in 1..16) as an unsigned integer, LSB first. */
  read(n: number): number {
    if (n === 0) return 0;
    if (this.count < n) {
      this.refill();
      if (this.count < n) throw new Error('unexpected end of DEFLATE stream');
    }
    const value = this.acc & ((1 << n) - 1);
    this.acc = (this.acc >>> n) >>> 0;
    this.count -= n;
    return value;
  }

  /** Ensure at least 16 bits are buffered for a table lookup and expose them. */
  peek16(): number {
    if (this.count < 16) this.refill();
    return this.acc & 0xffff;
  }

  /** Consume `n` bits previously inspected via peek16(). */
  consume(n: number): void {
    this.acc = (this.acc >>> n) >>> 0;
    this.count -= n;
  }

  /** Discard buffered sub-byte bits to reach a byte boundary. */
  alignToByte(): void {
    const rem = this.count & 7;
    if (rem) this.read(rem);
  }

  /** Current byte position in the underlying buffer (rounded up while buffered). */
  get bytePosition(): number {
    return this.pos - (this.count >> 3);
  }

  get bitPosition(): number {
    return this.pos * 8 - this.count;
  }

  /** Read one whole byte (used for stored blocks, which are byte aligned). */
  readByte(): number {
    return this.read(8);
  }
}

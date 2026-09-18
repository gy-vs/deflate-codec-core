/**
 * CRC-32 (IEEE 802.3 polynomial 0xEDB88320, reflected), the checksum used in
 * the gzip footer. A 4 KiB lookup table gives constant-time byte updates.
 */
const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export class Crc32 {
  private crc = 0xffffffff;

  update(data: Uint8Array, start = 0, end = data.length): this {
    let c = this.crc;
    for (let i = start; i < end; i++) {
      c = TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    }
    this.crc = c;
    return this;
  }

  /** Final CRC value (XOR-out applied). */
  get value(): number {
    return (this.crc ^ 0xffffffff) >>> 0;
  }

  static oneShot(data: Uint8Array, start = 0, end = data.length): number {
    return new Crc32().update(data, start, end).value;
  }
}

/**
 * CRC32（IEEE 802.3 多项式 0xEDB88320 反射形式），
 * gzip 尾部需要。标准查表实现，可增量更新。
 */

const TABLE: Uint32Array = (() => {
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

/** 计算整块数据的 CRC32，结果为无符号 32 位整数。 */
export function crc32(data: Uint8Array): number {
  return crc32Update(0, data);
}

/** 增量更新 CRC32。crc 取上一步的返回值，首块传 0。 */
export function crc32Update(crc: number, data: Uint8Array, start = 0, end = data.length): number {
  let c = crc ^ 0xffffffff;
  for (let i = start; i < end; i++) {
    c = TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

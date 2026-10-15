/**
 * MD5（RFC 1321）。
 *
 * 为什么自己写：WebCrypto **没有** MD5（只有 SHA 系列），
 * 而图书馆选座接口的 `submit_enc` 签名要求 MD5。
 * 另一条路是开 `nodejs_compat` 用 `node:crypto`，但为了一个哈希函数
 * 引入兼容标志不划算 —— 这里实现自包含版本，并用 RFC 1321 测试向量验证。
 *
 * 常量 T[i] 由 `floor(2^32 * |sin(i+1)|)` 在模块加载时算出，
 * 不手打 64 个常量，避免抄错。
 */

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const T = (() => {
  const table = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    table[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  }
  return table;
})();

function rotateLeft(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

/** 计算 MD5，返回 16 字节摘要。 */
export function md5(input: Uint8Array): Uint8Array {
  // ---- 填充：0x80，补零到长度 ≡ 56 (mod 64)，再附 8 字节小端比特长度 ----
  const bitLength = input.length * 8;
  const paddedLength = ((input.length + 8) >> 6 << 6) + 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input, 0);
  padded[input.length] = 0x80;

  const view = new DataView(padded.buffer);
  // 比特长度按小端写入最后 8 字节（本项目输入都很短，高 32 位为 0）
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 4294967296), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const m = new Uint32Array(16);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(offset + i * 4, true);

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }

      f = (f + a + T[i] + m[g]) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotateLeft(f, S[i])) >>> 0;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const digest = new Uint8Array(16);
  const out = new DataView(digest.buffer);
  out.setUint32(0, a0, true);
  out.setUint32(4, b0, true);
  out.setUint32(8, c0, true);
  out.setUint32(12, d0, true);
  return digest;
}

/** 计算 MD5 并返回小写十六进制字符串。 */
export function md5Hex(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return [...md5(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

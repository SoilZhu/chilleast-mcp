/**
 * 字节 / base64 / BigInt 小工具。
 * Workers 里没有 Node Buffer，统一用 Uint8Array + atob/btoa。
 */

/** 去掉 PEM 头尾与所有空白，得到纯 base64。 */
export function stripPem(pem: string): string {
  return pem.replace(/-----[^-]+-----|\s+/g, '');
}

/**
 * base64 / base64url -> bytes。同时容忍 PEM 包裹。
 * 顺手把 base64url 的 `-` `_` 归一化、补齐缺失的 `=`，
 * 因为有的服务端（以及 JWK）会用 url-safe 变体。
 */
export function b64ToBytes(input: string): Uint8Array {
  let clean = stripPem(input).replace(/-/g, '+').replace(/_/g, '/');
  const remainder = clean.length % 4;
  if (remainder === 1) {
    throw new Error('base64 长度非法');
  }
  if (remainder !== 0) clean += '='.repeat(4 - remainder);
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** bytes -> 标准 base64。 */
export function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000; // 避免 apply 参数过多
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

/** bytes -> base64url（无 padding）。用于令牌里那种要放进 URL/请求头的东西。 */
export function bytesToB64Url(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 密码学随机字节。 */
export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** 随机字节 -> base64url 字符串。 */
export function randomB64Url(length: number): string {
  return bytesToB64Url(randomBytes(length));
}

/** SHA-256 十六进制摘要。 */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return toHex(new Uint8Array(digest));
}

/** 大端无符号字节 -> BigInt。 */
export function bytesToBigInt(bytes: Uint8Array): bigint {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex === '' ? 0n : BigInt('0x' + hex);
}

/** BigInt -> 定长大端字节。 */
export function bigIntToBytes(value: bigint, length?: number): Uint8Array {
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = '0' + hex;
  const raw = new Uint8Array(hex.length / 2);
  for (let i = 0; i < raw.length; i++) {
    raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  if (length === undefined) return raw;
  if (raw.length > length) throw new Error('integer too large for requested length');
  const out = new Uint8Array(length);
  out.set(raw, length - raw.length);
  return out;
}

/** 常量时间比较（长度不同直接 false，此处只比较等长摘要）。 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** hex 编码。 */
export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

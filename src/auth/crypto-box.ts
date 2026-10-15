/**
 * AES-GCM 加密与解密工具。
 *
 * 用于 OAuth 授权码（authorization code）的自包含加密打包与验签，
 * 保证 /authorize 到 /token 之间无需数据库即可无状态传递临时授权凭据。
 */

import { b64ToBytes, bytesToB64 } from '../util/bytes';

const KEY_INFO = 'chilleast-mcp/session-key/v1';

export function getEffectiveSessionKey(env: { SESSION_KEY?: string }): string {
  if (env.SESSION_KEY && env.SESSION_KEY.length >= 32) {
    return env.SESSION_KEY;
  }
  throw new Error('SESSION_KEY 未正确配置（必须是至少 32 字节 base64 编码的密钥）');
}

let cachedKey: CryptoKey | null = null;
let cachedKeySource = '';

/** 把 base64 主密钥导入为 AES-GCM 密钥。 */
async function importKey(base64Key: string): Promise<CryptoKey> {
  if (cachedKey !== null && cachedKeySource === base64Key) return cachedKey;
  const raw = b64ToBytes(base64Key);
  if (raw.length !== 32) {
    throw new Error('SESSION_KEY 必须是 32 字节（base64 编码后的 AES-256 密钥）');
  }
  cachedKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
  cachedKeySource = base64Key;
  return cachedKey;
}

/** 加密：输出 `iv.ciphertext`（均为 base64）。 */
export async function seal(plaintext: string, base64Key: string): Promise<string> {
  const key = await importKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(KEY_INFO) },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `${bytesToB64(iv)}.${bytesToB64(new Uint8Array(ciphertext))}`;
}

/** 解密。 */
export async function open(sealed: string, base64Key: string): Promise<string> {
  const separator = sealed.indexOf('.');
  if (separator <= 0) throw new Error('密文格式无效');
  const iv = b64ToBytes(sealed.slice(0, separator));
  const ciphertext = b64ToBytes(sealed.slice(separator + 1));
  const key = await importKey(base64Key);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(KEY_INFO) },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(plaintext);
}

/**
 * 凭据指纹：用于单实例内存会话防抖缓存隔离键。
 *
 * 有 pepper 时用 HMAC-SHA256(pepper, 学号 + NUL + 密码) —— 单向且带密钥。
 * 没配 pepper 时退化为无盐 SHA-256，`/health` 会报 `accountPepperConfigured: false`。
 */
export async function credentialFingerprint(
  oaId: string,
  oaKey: string,
  pepper = '',
): Promise<string> {
  return await keyedHash(pepper, `${oaId}\u0000${oaKey}`);
}

/**
 * 账号级哈希，用于「按学号计数」这类键（登录失败锁定）。
 * 单独一个 info 前缀，避免和凭据指纹撞上。
 */
export async function accountHash(oaId: string, pepper = ''): Promise<string> {
  return await keyedHash(pepper, `account\u0000${oaId}`);
}

/** HMAC-SHA256(pepper, input)；pepper 为空时退化为 SHA-256(input)。 */
async function keyedHash(pepperBase64: string, input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  if (pepperBase64 === '') {
    const digest = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const raw = b64ToBytes(pepperBase64);
  if (raw.length < 16) {
    throw new Error('ACCOUNT_PEPPER 太短（至少 16 字节，建议 32）');
  }
  const key = await crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, data);
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

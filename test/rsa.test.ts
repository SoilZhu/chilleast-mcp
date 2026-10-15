import { describe, expect, it } from 'vitest';
import {
  encodeCimsPlaintext,
  encryptCimsPassword,
  parseRsaPublicKey,
  rsaEncryptPkcs1v15,
} from '../src/auth/rsa';

// ---- 测试用工具：从 JWK 手搓 DER，用于覆盖 SPKI / PKCS#1 两种容器 ----------

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesToBigIntLocal(bytes: Uint8Array): bigint {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex === '' ? 0n : BigInt('0x' + hex);
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function derInteger(value: bigint): Uint8Array {
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = '0' + hex;
  const raw = new Uint8Array(hex.length / 2);
  for (let i = 0; i < raw.length; i++) raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  // 最高位为 1 时要补一个 0x00，避免被当成负数
  const needsPad = (raw[0] & 0x80) !== 0;
  const body = needsPad ? new Uint8Array([0x00, ...raw]) : raw;
  return new Uint8Array([0x02, ...derLength(body.length), ...body]);
}

function derSequence(...parts: Uint8Array[]): Uint8Array {
  const body = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  return new Uint8Array([0x30, ...derLength(body.length), ...body]);
}

/** 生成一对 RSA 密钥（用 RSA-OAEP 生成即可，我们只借用它的 n/e/d）。 */
async function generateRsa(modulusLength = 2048) {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['encrypt', 'decrypt'],
  )) as CryptoKeyPair;

  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  const n = bytesToBigIntLocal(base64UrlToBytes(jwk.n!));
  const e = bytesToBigIntLocal(base64UrlToBytes(jwk.e!));
  const d = bytesToBigIntLocal(base64UrlToBytes(jwk.d!));
  const spki = new Uint8Array(
    (await crypto.subtle.exportKey('spki', pair.publicKey)) as ArrayBuffer,
  );
  const pkcs1 = derSequence(derInteger(n), derInteger(e));

  return { n, e, d, spki, pkcs1 };
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = base % modulus;
  let exp = exponent;
  while (exp > 0n) {
    if (exp & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    exp >>= 1n;
  }
  return result;
}

function bigIntToBytes(value: bigint, length: number): Uint8Array {
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = '0' + hex;
  const raw = new Uint8Array(hex.length / 2);
  for (let i = 0; i < raw.length; i++) raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const out = new Uint8Array(length);
  out.set(raw, length - raw.length);
  return out;
}

/** 用私钥解出 PKCS#1 v1.5 块里的明文，顺便校验填充结构。 */
function rsaDecryptPkcs1v15(
  ciphertextB64: string,
  key: { n: bigint; d: bigint; size: number },
): Uint8Array {
  const bin = atob(ciphertextB64);
  const cipher = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) cipher[i] = bin.charCodeAt(i);

  const block = bigIntToBytes(modPow(bytesToBigIntLocal(cipher), key.d, key.n), key.size);
  expect(block[0]).toBe(0x00);
  expect(block[1]).toBe(0x02);

  // 填充串必须非零，直到第一个 0x00 分隔符
  let index = 2;
  while (index < block.length && block[index] !== 0x00) {
    expect(block[index]).not.toBe(0);
    index++;
  }
  expect(index).toBeGreaterThanOrEqual(10); // 至少 8 字节填充
  return block.subarray(index + 1);
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

// ---- 测试 ----------------------------------------------------------------

describe('encodeCimsPlaintext', () => {
  it('ASCII 就是普通字节', () => {
    expect([...encodeCimsPlaintext('abc', 'tok')]).toEqual([...new TextEncoder().encode('abc|tok')]);
  });

  it('中文按 UTF-8 编码', () => {
    expect([...encodeCimsPlaintext('密码', 't')]).toEqual([...new TextEncoder().encode('密码|t')]);
  });

  it('星辰平面字符按 UTF-16 code unit 编码（与 JSEncrypt 2.3 一致，即 CESU-8）', () => {
    // Dart 侧测试锁定：'😀' -> ED A0 BD ED B8 80
    expect([...encodeCimsPlaintext('😀', 't')]).toEqual([
      0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80, 0x7c, 0x74,
    ]);
  });
});

describe('parseRsaPublicKey', () => {
  it('解析 SPKI 容器', async () => {
    const key = await generateRsa();
    const parsed = parseRsaPublicKey(bytesToBase64Url(key.spki));
    expect(parsed.n).toBe(key.n);
    expect(parsed.e).toBe(key.e);
    expect(parsed.size).toBe(256);
  });

  it('解析 PKCS#1 容器', async () => {
    const key = await generateRsa();
    const parsed = parseRsaPublicKey(bytesToBase64Url(key.pkcs1));
    expect(parsed.n).toBe(key.n);
    expect(parsed.e).toBe(key.e);
  });

  it('接受 PEM 包裹与换行', async () => {
    const key = await generateRsa();
    // 不带 PEM 头时也能解析（学校接口返回的就是裸 base64 DER）
    const bare = bytesToBase64Url(key.spki);
    const chunked = bare.match(/.{1,64}/g)!.join('\n');
    const parsed = parseRsaPublicKey(
      `-----BEGIN PUBLIC KEY-----\n${chunked}\n-----END PUBLIC KEY-----`,
    );
    expect(parsed.n).toBe(key.n);
  });

  it('公钥过小时拒绝', () => {
    const tiny = derSequence(derInteger(0x12345n), derInteger(65537n));
    expect(() => parseRsaPublicKey(bytesToBase64Url(tiny))).toThrow();
  });
});

describe('rsaEncryptPkcs1v15', () => {
  it('产出可被私钥还原的 PKCS#1 v1.5 type-2 块', async () => {
    const key = await generateRsa();
    const message = new TextEncoder().encode('my-password|one-time-token');
    const ciphertext = rsaEncryptPkcs1v15({ n: key.n, e: key.e, size: 256 }, message);

    const recovered = rsaDecryptPkcs1v15(ciphertext, { n: key.n, d: key.d, size: 256 });
    expect(decodeUtf8(recovered)).toBe('my-password|one-time-token');
  });

  it('每次加密结果都不同（随机填充）', async () => {
    const key = await generateRsa();
    const message = new TextEncoder().encode('same|same');
    const rsaKey = { n: key.n, e: key.e, size: 256 };
    expect(rsaEncryptPkcs1v15(rsaKey, message)).not.toBe(rsaEncryptPkcs1v15(rsaKey, message));
  });

  it('密文长度等于模长', async () => {
    const key = await generateRsa();
    const ciphertext = rsaEncryptPkcs1v15(
      { n: key.n, e: key.e, size: 256 },
      new TextEncoder().encode('x|y'),
    );
    expect(atob(ciphertext).length).toBe(256);
  });

  it('明文超过 k-11 时抛错', async () => {
    const key = await generateRsa();
    const tooLong = new Uint8Array(246);
    expect(() =>
      rsaEncryptPkcs1v15({ n: key.n, e: key.e, size: 256 }, tooLong),
    ).toThrow(/too long/);
  });
});

describe('encryptCimsPassword', () => {
  it('INTERNATIONAL 走 RSA 并可用私钥还原 password|token', async () => {
    const key = await generateRsa();
    const encrypted = encryptCimsPassword(
      bytesToBase64Url(key.spki),
      'INTERNATIONAL',
      'hunter2',
      'tok-123',
    );
    const recovered = rsaDecryptPkcs1v15(encrypted, { n: key.n, d: key.d, size: 256 });
    expect(decodeUtf8(recovered)).toBe('hunter2|tok-123');
  });

  it('接受 PKCS#1 格式的公钥', async () => {
    const key = await generateRsa();
    const encrypted = encryptCimsPassword(
      bytesToBase64Url(key.pkcs1),
      'INTERNATIONAL',
      'pw',
      't',
    );
    expect(decodeUtf8(rsaDecryptPkcs1v15(encrypted, { n: key.n, d: key.d, size: 256 }))).toBe('pw|t');
  });

  it('NATIONAL(SM2) 明确失败，不静默降级', async () => {
    const key = await generateRsa();
    expect(() =>
      encryptCimsPassword(bytesToBase64Url(key.spki), 'NATIONAL', 'pw', 't'),
    ).toThrow(/SM2/);
  });

  it('未知 encryptor 失败', async () => {
    const key = await generateRsa();
    expect(() =>
      encryptCimsPassword(bytesToBase64Url(key.spki), 'WHATEVER', 'pw', 't'),
    ).toThrow(/未知密码加密配置/);
  });

  it('公钥损坏时给出可读错误', () => {
    expect(() => encryptCimsPassword('!!!not-a-key!!!', 'INTERNATIONAL', 'pw', 't')).toThrow(
      /公钥格式无效/,
    );
  });
});

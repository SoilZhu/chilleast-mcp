import { describe, expect, it } from 'vitest';
import {
  __testing,
  aesEcbDecrypt,
  aesEcbDecryptUtf8Key,
  aesEcbEncrypt,
  aesEcbEncryptUtf8Key,
  pkcs7Pad,
  pkcs7Unpad,
} from '../src/util/aes';
import { b64ToBytes, bytesToB64 } from '../src/util/bytes';

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('推导出来的 S 盒', () => {
  it('关键取值与 FIPS-197 一致', () => {
    const { SBOX, INV_SBOX } = __testing;
    // 这几个值如果推导写错最容易露馅
    expect(SBOX[0x00]).toBe(0x63);
    expect(SBOX[0x01]).toBe(0x7c);
    expect(SBOX[0x53]).toBe(0xed);
    expect(SBOX[0xff]).toBe(0x16);
    // 逆 S 盒必须是真的逆
    for (let i = 0; i < 256; i++) expect(INV_SBOX[SBOX[i]]).toBe(i);
  });
});

describe('PKCS#7 填充', () => {
  it('补齐到块边界', () => {
    expect(pkcs7Pad(new Uint8Array([1, 2, 3])).length).toBe(16);
    expect(pkcs7Pad(new Uint8Array(16)).length).toBe(32); // 整块时补满一整块
    expect(pkcs7Pad(new Uint8Array(0)).length).toBe(16);
  });

  it('往返一致', () => {
    for (const length of [0, 1, 15, 16, 17, 31, 32]) {
      const data = crypto.getRandomValues(new Uint8Array(length));
      expect([...pkcs7Unpad(pkcs7Pad(data))]).toEqual([...data]);
    }
  });

  it('拒绝非法填充', () => {
    const bad = new Uint8Array(16).fill(0);
    bad[15] = 0;
    expect(() => pkcs7Unpad(bad)).toThrow();

    const bad2 = new Uint8Array(16).fill(0);
    bad2[15] = 5;
    bad2[11] = 9;
    expect(() => pkcs7Unpad(bad2)).toThrow();
  });
});

describe('AES-ECB 已知答案测试（对齐 NIST 与 Node crypto）', () => {
  it('AES-128 单块匹配 FIPS-197 向量', () => {
    const key = hexToBytes('000102030405060708090a0b0c0d0e0f');
    const plaintext = hexToBytes('00112233445566778899aabbccddeeff');
    const ciphertext = aesEcbEncrypt(key, plaintext);
    // 前 16 字节就是该向量的结果（后面是 PKCS#7 补出来的整块）
    expect(bytesToHex(ciphertext.subarray(0, 16))).toBe('69c4e0d86a7b0430d8cdb78070b4c55a');
  });

  it('AES-192 / AES-256 密钥扩展也正确', () => {
    // FIPS-197 附录 C 的向量
    const plaintext = hexToBytes('00112233445566778899aabbccddeeff');

    const key192 = hexToBytes('000102030405060708090a0b0c0d0e0f1011121314151617');
    expect(bytesToHex(aesEcbEncrypt(key192, plaintext).subarray(0, 16))).toBe(
      'dda97ca4864cdfe06eaf70a0ec0d7191',
    );

    const key256 = hexToBytes('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    expect(bytesToHex(aesEcbEncrypt(key256, plaintext).subarray(0, 16))).toBe(
      '8ea2b7ca516745bfeafc49904b496089',
    );
  });

  it('ydjwxt 登录密码与 Node crypto 结果一致', () => {
    // 期望值由 Node: createCipheriv('aes-128-ecb', 'qzkj1kjghd=876&*') 生成
    const KEY = 'qzkj1kjghd=876&*';
    expect(bytesToB64(aesEcbEncryptUtf8Key(KEY, JSON.stringify('mypassword')))).toBe(
      'rd6keDq3zEVuqu3OYdJ4fw==',
    );
    expect(bytesToB64(aesEcbEncryptUtf8Key(KEY, JSON.stringify('')))).toBe(
      '4pUl8GLS1U/pjssbzH+o/A==',
    );
    expect(bytesToB64(aesEcbEncryptUtf8Key(KEY, JSON.stringify('密码123')))).toBe(
      'waMbNtKDGb7iC8PknDPaPg==',
    );
  });
});

describe('AES-ECB 加解密往返', () => {
  it('随机数据在各种长度下都往返一致', () => {
    for (const length of [0, 1, 15, 16, 17, 64, 200, 1024]) {
      const plaintext = crypto.getRandomValues(new Uint8Array(length));
      const key = crypto.getRandomValues(new Uint8Array(16));
      const ciphertext = aesEcbEncrypt(key, plaintext);
      expect([...aesEcbDecrypt(key, ciphertext)]).toEqual([...plaintext]);
    }
  });

  it('UTF-8 文本往返一致', () => {
    const text = '{"datajson":"中文内容 with mixed 内容"}';
    const ciphertext = aesEcbEncryptUtf8Key('0123456789abcdef', text);
    expect(aesEcbDecryptUtf8Key('0123456789abcdef', ciphertext)).toBe(text);
  });

  it('ECB 的确定性：相同输入产生相同密文（这正是 ECB 的特征）', () => {
    const key = new Uint8Array(16).fill(3);
    const a = aesEcbEncrypt(key, new TextEncoder().encode('same'));
    const b = aesEcbEncrypt(key, new TextEncoder().encode('same'));
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });

  it('密钥长度非法时明确报错', () => {
    expect(() => aesEcbEncrypt(new Uint8Array(8), new Uint8Array(16))).toThrow(/16\/24\/32/);
  });

  it('密文长度非法时报错', () => {
    expect(() => aesEcbDecrypt(new Uint8Array(16), new Uint8Array(15))).toThrow();
  });

  it('密文损坏时填充校验失败（不会静默返回垃圾）', () => {
    const key = new Uint8Array(16).fill(7);
    const ciphertext = aesEcbEncrypt(key, new TextEncoder().encode('secret'));
    ciphertext[0] ^= 0xff;
    expect(() => aesEcbDecrypt(key, ciphertext)).toThrow();
  });
});

describe('base64 工具与 AES 配合', () => {
  it('base64 解码容忍 url-safe 与缺省填充', () => {
    expect([...b64ToBytes('rd6keDq3zEVuqu3OYdJ4fw==')]).toEqual([
      ...b64ToBytes('rd6keDq3zEVuqu3OYdJ4fw'),
    ]);
  });
});

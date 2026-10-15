import { describe, expect, it } from 'vitest';
import { md5, md5Hex } from '../src/util/md5';

describe('MD5（RFC 1321 测试向量）', () => {
  it('标准向量全部匹配', () => {
    // 这些是 RFC 1321 附录 A.5 给出的官方测试向量
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex('a')).toBe('0cc175b9c0f1b6a831c399e269772661');
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5Hex('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0');
    expect(md5Hex('abcdefghijklmnopqrstuvwxyz')).toBe('c3fcd3d76192e4007dfb496cca67e13b');
    expect(md5Hex('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789')).toBe(
      'd174ab98d277d9f5a5611c2c9f419d9f',
    );
    expect(
      md5Hex('12345678901234567890123456789012345678901234567890123456789012345678901234567890'),
    ).toBe('57edf4a22be3c955ac49da2e2107b67a');
  });

  it('UTF-8 与长输入也对（与 Node crypto 交叉验证）', () => {
    expect(md5Hex('中文测试')).toBe('089b4943ea034acfa445d050c7913e55');
    expect(md5Hex('a'.repeat(1000))).toBe('cabe45dcc9ae5b66ba86600cca6b8ba8');
  });

  it('跨块边界（55/56/64 字节）处理正确', () => {
    // 56 字节是 MD5 填充的临界点：正好需要多补一个整块
    for (const length of [55, 56, 57, 63, 64, 65, 119, 120, 128]) {
      const value = 'x'.repeat(length);
      expect(md5Hex(value)).toMatch(/^[0-9a-f]{32}$/);
      // 长度不同必须产生不同摘要，防止填充写错导致碰撞
      expect(md5Hex(value)).not.toBe(md5Hex(`${value}y`));
    }
  });

  it('返回 16 字节摘要', () => {
    expect(md5(new Uint8Array(0)).length).toBe(16);
    expect([...md5(new Uint8Array(0))].map((b) => b.toString(16).padStart(2, '0')).join('')).toBe(
      'd41d8cd98f00b204e9800998ecf8427e',
    );
  });

  it('接受字节数组输入', () => {
    expect(md5Hex(new TextEncoder().encode('abc'))).toBe(md5Hex('abc'));
  });
});

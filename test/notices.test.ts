import { describe, expect, it } from 'vitest';
import { parseJsonOrExpire } from '../src/tools/notices';
import { SessionExpiredError } from '../src/auth/session-manager';
import { parseCimsBootstrap } from '../src/auth/cims';

describe('超星会话失效的识别', () => {
  it('识别「合法 JSON 但未登录」——这是最关键的一种', () => {
    // 超星会话失效时返回的是 HTTP 200 + 合法 JSON，不是 HTML。
    // 只识别 HTML 形态的话，这里会被当成"没有通知"，
    // 会话静默过期后永远恢复不了（不会触发重登）。
    const body = JSON.stringify({ msg: '您当前未登录', success: false });
    expect(() => parseJsonOrExpire(body)).toThrow(SessionExpiredError);
  });

  it('识别 HTML 登录页', () => {
    expect(() => parseJsonOrExpire('<!DOCTYPE html><html>...')).toThrow(SessionExpiredError);
  });

  it('识别无法解析的内容', () => {
    expect(() => parseJsonOrExpire('not json at all')).toThrow(SessionExpiredError);
  });

  it('正常的通知响应照常返回', () => {
    const body = JSON.stringify({ notices: { list: [{ uuid: 'u1' }], lastGetId: '123' } });
    const parsed = parseJsonOrExpire(body);
    expect(parsed['notices']).toBeDefined();
  });

  it('success:false 但消息与登录无关时不算会话失效（避免误重登）', () => {
    const body = JSON.stringify({ msg: '参数错误', success: false });
    expect(() => parseJsonOrExpire(body)).not.toThrow();
  });
});

describe('HTMLRewriter 空 body 短路', () => {
  it('登录页解析对纯空白输入快速失败，不会挂住', async () => {
    // workerd 的 HTMLRewriter 对空 body 的 transform().text() 永不 resolve，
    // 所以所有调用点都必须先短路。这里用超时兜住回归。
    const started = Date.now();
    await expect(
      Promise.race([
        parseCimsBootstrap('   \n  ', 'https://sso.hunau.edu.cn/cas/login'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('挂住了')), 3000)),
      ]),
    ).rejects.toThrow(/CIMS/);
    expect(Date.now() - started).toBeLessThan(2500);
  });
});

describe('通知字段归一', () => {
  it('count_all/count_read 是接收与已读人数，不再冒充"我的未读数"', async () => {
    const { normalizeNotice } = await import('../src/tools/notices');
    const normalized = normalizeNotice({
      uuid: 'u1',
      content: '标题\n正文',
      createrName: '智慧湘农通知',
      insertTime: 1758000000000,
      isread: 0,
      count_all: 34136,
      count_read: 120,
    });
    // 之前这里会输出 unreadCount: 34016，会被模型理解成"我有 3 万条未读"
    expect(normalized['unreadCount']).toBeUndefined();
    expect(normalized['recipientCount']).toBe(34136);
    expect(normalized['readCount']).toBe(120);
    expect(normalized['isRead']).toBe(false);
    expect(normalized['title']).toBe('标题');
  });

  it('字段缺失时不臆造 0', async () => {
    const { normalizeNotice } = await import('../src/tools/notices');
    const normalized = normalizeNotice({ uuid: 'u2', content: 'x', isread: 1 });
    expect(normalized['recipientCount']).toBeUndefined();
    expect(normalized['readCount']).toBeUndefined();
    expect(normalized['isRead']).toBe(true);
  });

  it('count 为字符串数字时也能认', async () => {
    const { normalizeNotice } = await import('../src/tools/notices');
    const normalized = normalizeNotice({ uuid: 'u3', count_all: '50', count_read: '10' });
    expect(normalized['recipientCount']).toBe(50);
    expect(normalized['readCount']).toBe(10);
  });
});

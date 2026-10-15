import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildHomeworkEntries,
  classifyHomeworkStatus,
  fetchRemoteHomework,
  HOMEWORK_URL,
  looksLikeLoginPage,
  parseHomeworkHtml,
  parseRemainTime,
  transformHomeworkDataUrl,
} from '../src/school/hunau/chaoxing-study';
import {
  filterHomework,
  homeworkToJson,
  parseHomeworkFilter,
  sortHomework,
  type HomeworkEntry,
} from '../src/school/hunau/homework-model';
import { createHomeworkTools } from '../src/tools/homework';
import { formatBeijing, parseBeijingDateTime } from '../src/school/hunau/time';
import { CookieJar } from '../src/auth/cookies';
import { CookieSession } from '../src/auth/http';
import { SessionExpiredError } from '../src/auth/session-manager';

/** 固定基准时间：2026-10-14 12:00（北京时间） */
const NOW = Date.UTC(2026, 9, 14, 4, 0, 0);
const MINUTE = 60_000;

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 纯逻辑：状态判定
// ---------------------------------------------------------------------------

describe('classifyHomeworkStatus（照抄 homework_service.dart 的核心判定）', () => {
  it('状态不是「未提交」一律视为已完成', () => {
    expect(classifyHomeworkStatus('已完成', false, '剩余10小时')).toBe('completed');
    expect(classifyHomeworkStatus('已批阅', false, '')).toBe('completed');
    expect(classifyHomeworkStatus('待批阅', false, '剩余3分钟')).toBe('completed');
  });

  it('未提交 + 非灰图标 + 有剩余时间 = 待完成', () => {
    expect(classifyHomeworkStatus('未提交', false, '剩余194小时34分钟')).toBe('pending');
  });

  it('未提交 + 灰图标 = 已存档（即使还有剩余时间）', () => {
    expect(classifyHomeworkStatus('未提交', true, '剩余194小时34分钟')).toBe('archived');
  });

  it('未提交 + 没有剩余时间 = 已存档', () => {
    expect(classifyHomeworkStatus('未提交', false, '')).toBe('archived');
  });

  it('把「未交」也当作未提交（Dart 只认「未提交」，这里有意放宽）', () => {
    expect(classifyHomeworkStatus('未交', false, '剩余1小时')).toBe('pending');
    expect(classifyHomeworkStatus('未交', true, '')).toBe('archived');
  });

  it('状态两侧空白不影响判定', () => {
    expect(classifyHomeworkStatus('  未提交 ', false, ' 剩余1分钟 ')).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// 纯逻辑：剩余时间解析
// ---------------------------------------------------------------------------

describe('parseRemainTime（剩余X天Y小时Z分钟 -> 截止时间戳）', () => {
  it('只有小时+分钟', () => {
    expect(parseRemainTime('剩余194小时34分钟', NOW)).toBe(NOW + (194 * 60 + 34 + 1) * MINUTE);
  });

  it('只有分钟', () => {
    expect(parseRemainTime('剩余30分钟', NOW)).toBe(NOW + 31 * MINUTE);
  });

  it('天 + 小时', () => {
    expect(parseRemainTime('剩余2天3小时', NOW)).toBe(NOW + (2 * 24 * 60 + 3 * 60 + 1) * MINUTE);
  });

  it('天 + 小时 + 分钟', () => {
    expect(parseRemainTime('剩余1天2小时3分钟', NOW)).toBe(
      NOW + (24 * 60 + 2 * 60 + 3 + 1) * MINUTE,
    );
  });

  it('没有数字 / 全为零分钟时返回 null', () => {
    expect(parseRemainTime('剩余', NOW)).toBeNull();
    expect(parseRemainTime('剩余0分钟', NOW)).toBeNull();
    expect(parseRemainTime('', NOW)).toBeNull();
  });

  it('与 Dart 一致：解析结果额外 +1 分钟', () => {
    expect(parseRemainTime('剩余1分钟', NOW)).toBe(NOW + 2 * MINUTE);
  });
});

// ---------------------------------------------------------------------------
// 纯逻辑：详情链接转换
// ---------------------------------------------------------------------------

describe('transformHomeworkDataUrl（安卓跳转链接 -> 手机网页版）', () => {
  const android =
    'https://mooc1-api.chaoxing.com/mooc-ans/android/mtaskmsgspecial?taskrefId=51740957&msgId=0' +
    '&courseId=261566913&userId=342380530&clazzId=142140293&type=work&enc_task=abc';

  it('clazzId 被改写成 classId，并固定 ut=s', () => {
    expect(transformHomeworkDataUrl(android)).toBe(
      'https://mooc1-api.chaoxing.com/mooc-ans/work/phone/task-work' +
        '?taskrefId=51740957&courseId=261566913&classId=142140293&ut=s',
    );
  });

  it('空串原样返回', () => {
    expect(transformHomeworkDataUrl('')).toBe('');
  });

  it('参数不全时原样返回', () => {
    const partial = 'https://mooc1-api.chaoxing.com/x?taskrefId=1&courseId=2';
    expect(transformHomeworkDataUrl(partial)).toBe(partial);
  });

  it('不是合法 URL 时原样返回（对齐 Dart 的 catch 分支）', () => {
    expect(transformHomeworkDataUrl('not a url')).toBe('not a url');
  });
});

// ---------------------------------------------------------------------------
// HTML 解析（HTMLRewriter，真实跑在 workerd 里）
// ---------------------------------------------------------------------------

const HOMEWORK_HTML = `<!DOCTYPE html><html><body>
<ul class="workList">
  <li onclick="goTask(this)" data="https://mooc1-api.chaoxing.com/mooc-ans/android/mtaskmsgspecial?taskrefId=1&courseId=2&clazzId=3">
    <div class="spanImg"><img src="/mooc-ans/static/task-work.png"></div>
    <div role="option">
      <p>第一次作业</p>
      <span class="status">未提交</span>
      <span>《高等数学》</span>
      <span>剩余194小时34分钟</span>
    </div>
  </li>
  <li onclick="goTask(this)" data="https://mooc1-api.chaoxing.com/mooc-ans/android/mtaskmsgspecial?taskrefId=4&courseId=5&clazzId=6">
    <div class="spanImg"><img src="/mooc-ans/static/task-work-gray.png"></div>
    <div role="option">
      <p>第二次作业</p>
      <span class="status">未提交</span>
      <span>《大学英语》</span>
      <span>剩余2天3小时</span>
    </div>
  </li>
  <li onclick="goTask(this)" data="">
    <div class="spanImg"><img src="/mooc-ans/static/task-work.png"></div>
    <div role="option">
      <p>没有课程也没有时间的作业</p>
      <span class="status">已完成</span>
    </div>
  </li>
  <li onclick="goTask(this)" data="https://mooc1-api.chaoxing.com/x?taskrefId=9">
    <div class="spanImg"><img src="/mooc-ans/static/task-work.png"></div>
  </li>
  <li onclick="other()" data="https://mooc1-api.chaoxing.com/ignored">
    <div role="option"><p>onclick 不是 goTask，应忽略</p></div>
  </li>
</ul>
</body></html>`;

describe('parseHomeworkHtml + buildHomeworkEntries', () => {
  it('解析出标题、课程、状态、剩余时间与详情链接', async () => {
    const raws = await parseHomeworkHtml(HOMEWORK_HTML);
    // 没有 div[role=option] 的 li 也会被解析出来，由 build 阶段跳过（对齐 Dart 的 continue）
    expect(raws).toHaveLength(4);

    const entries = buildHomeworkEntries(raws, NOW);
    expect(entries).toHaveLength(3);

    const first = entries[0];
    expect(first?.title).toBe('第一次作业');
    expect(first?.courseName).toBe('《高等数学》');
    expect(first?.status).toBe('pending');
    expect(first?.rawTimeStr).toBe('剩余194小时34分钟');
    expect(first?.endTimeMs).toBe(NOW + (194 * 60 + 34 + 1) * MINUTE);
    expect(first?.dataUrl).toBe(
      'https://mooc1-api.chaoxing.com/mooc-ans/work/phone/task-work' +
        '?taskrefId=1&courseId=2&classId=3&ut=s',
    );
    // id 用转换前的原始 dataUrl
    expect(first?.id).toContain('mtaskmsgspecial');

    const second = entries[1];
    expect(second?.title).toBe('第二次作业');
    expect(second?.courseName).toBe('《大学英语》');
    // 灰图标 -> 已存档
    expect(second?.status).toBe('archived');
    expect(second?.endTimeMs).toBe(NOW + (2 * 24 * 60 + 3 * 60 + 1) * MINUTE);
  });

  it('没有 data 的条目 id 退化为「课程名|标题」', async () => {
    const entries = buildHomeworkEntries(await parseHomeworkHtml(HOMEWORK_HTML), NOW);
    const third = entries[2];
    expect(third?.title).toBe('没有课程也没有时间的作业');
    expect(third?.courseName).toBe('');
    expect(third?.status).toBe('completed');
    expect(third?.endTimeMs).toBeNull();
    expect(third?.id).toBe('|没有课程也没有时间的作业');
  });

  it('嵌套 span 时与 Dart 行为一致：内层文本会覆盖外层的剩余时间', async () => {
    const html = `<ul><li onclick="goTask(this)" data="https://x/y?taskrefId=1">
      <div role="option"><p>嵌套</p><span>剩余194<span>小时</span>34分钟</span></div>
    </li></ul>`;
    const entries = buildHomeworkEntries(await parseHomeworkHtml(html), NOW);
    // 外层 span 文本是「剩余194小时34分钟」，但其内层 span「小时」后出现并覆盖它
    expect(entries[0]?.rawTimeStr).toBe('小时');
    expect(entries[0]?.endTimeMs).toBeNull();
  });

  it('没有任何 li[onclick^=goTask] 时返回空数组', async () => {
    const entries = buildHomeworkEntries(await parseHomeworkHtml('<div>空页面</div>'), NOW);
    expect(entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 筛选 / 排序 / 输出
// ---------------------------------------------------------------------------

function entry(overrides: Partial<HomeworkEntry>): HomeworkEntry {
  return {
    id: 'id',
    title: '标题',
    courseName: '《课程》',
    status: 'pending',
    endTimeMs: null,
    rawTimeStr: '',
    dataUrl: '',
    ...overrides,
  };
}

describe('parseHomeworkFilter', () => {
  it('缺省值是 pending（对齐 Dart 的 ?? "pending"）', () => {
    expect(parseHomeworkFilter({}).status).toBe('pending');
    expect(parseHomeworkFilter({ status: '  ' }).status).toBe('pending');
  });

  it('合法值原样使用', () => {
    expect(parseHomeworkFilter({ status: 'completed' }).status).toBe('completed');
    expect(parseHomeworkFilter({ status: 'all' }).status).toBe('all');
  });

  it('非法值退化成 all（Dart 里非三个已知值即不过滤）', () => {
    expect(parseHomeworkFilter({ status: 'foo' }).status).toBe('all');
    expect(parseHomeworkFilter({ status: 42 }).status).toBe('pending');
  });

  it('courseName / keyword 去空白', () => {
    const filter = parseHomeworkFilter({ courseName: ' 数学 ', keyword: ' 作业 ' });
    expect(filter.courseName).toBe('数学');
    expect(filter.keyword).toBe('作业');
  });
});

describe('filterHomework / sortHomework', () => {
  const entries = [
    entry({ id: 'a', title: '高数作业', courseName: '《高等数学》', status: 'pending', endTimeMs: 300 }),
    entry({ id: 'b', title: '英语作文', courseName: '《大学英语》', status: 'completed', endTimeMs: 100 }),
    entry({ id: 'c', title: '物理实验', courseName: '《大学物理》', status: 'pending', endTimeMs: null }),
  ];

  it('按状态过滤', () => {
    expect(filterHomework(entries, { status: 'pending', courseName: '', keyword: '' }).map((e) => e.id)).toEqual(['a', 'c']);
    expect(filterHomework(entries, { status: 'all', courseName: '', keyword: '' })).toHaveLength(3);
  });

  it('课程名大小写不敏感的子串匹配', () => {
    expect(
      filterHomework(entries, { status: 'all', courseName: '高等', keyword: '' }).map((e) => e.id),
    ).toEqual(['a']);
  });

  it('关键词命中标题或课程名', () => {
    expect(
      filterHomework(entries, { status: 'all', courseName: '', keyword: '作文' }).map((e) => e.id),
    ).toEqual(['b']);
    expect(
      filterHomework(entries, { status: 'all', courseName: '', keyword: '物理' }).map((e) => e.id),
    ).toEqual(['c']);
  });

  it('按截止时间升序，无截止时间的排最后', () => {
    expect(sortHomework(entries).map((e) => e.id)).toEqual(['b', 'a', 'c']);
  });

  it('排序不修改入参数组', () => {
    const original = [...entries];
    sortHomework(entries);
    expect(entries).toEqual(original);
  });
});

describe('homeworkToJson', () => {
  it('课程名为空时显示「自定义作业」，并给出中英文状态', () => {
    const json = homeworkToJson(entry({ courseName: '', status: 'archived' }));
    expect(json['courseName']).toBe('自定义作业');
    expect(json['status']).toBe('已存档/已截止');
    expect(json['statusCode']).toBe('archived');
    expect(json['isManual']).toBe(false);
    expect(json['source']).toBe('chaoxing');
    expect(json['endTime']).toBeNull();
    expect(json['endTimeLocal']).toBeNull();
  });

  it('截止时间同时给出 ISO(UTC) 与北京时间', () => {
    const endTimeMs = Date.UTC(2026, 9, 14, 4, 0, 0); // 北京时间 12:00
    const json = homeworkToJson(entry({ endTimeMs }));
    expect(json['endTime']).toBe('2026-10-14T04:00:00.000Z');
    expect(json['endTimeLocal']).toBe('2026-10-14 12:00:00');
  });
});

// ---------------------------------------------------------------------------
// 时间工具（作业链路依赖）
// ---------------------------------------------------------------------------

describe('北京时间工具', () => {
  it('无时区的墙上时间按北京时间解析', () => {
    expect(parseBeijingDateTime('2026-05-10 17:00:00')).toBe(Date.UTC(2026, 4, 10, 9, 0, 0));
    expect(parseBeijingDateTime('2026-05-10 17:00')).toBe(Date.UTC(2026, 4, 10, 9, 0, 0));
    expect(parseBeijingDateTime('2026-05-10T17:00:00.000')).toBe(Date.UTC(2026, 4, 10, 9, 0, 0));
  });

  it('带时区的 ISO8601 按显式偏移解析', () => {
    expect(parseBeijingDateTime('2026-05-10T09:00:00.000Z')).toBe(Date.UTC(2026, 4, 10, 9, 0, 0));
    expect(parseBeijingDateTime('2026-05-10T17:00:00+08:00')).toBe(Date.UTC(2026, 4, 10, 9, 0, 0));
  });

  it('非法日期返回 null，而不是静默进位', () => {
    expect(parseBeijingDateTime('2026-13-01 10:00')).toBeNull();
    expect(parseBeijingDateTime('2026-02-30 10:00')).toBeNull();
    expect(parseBeijingDateTime('2026-05-10 25:00')).toBeNull();
    expect(parseBeijingDateTime('明天')).toBeNull();
  });

  it('格式化输出北京时间（含/不含秒）', () => {
    const epochMs = Date.UTC(2026, 9, 14, 4, 5, 6);
    expect(formatBeijing(epochMs)).toBe('2026-10-14 12:05');
    expect(formatBeijing(epochMs, true)).toBe('2026-10-14 12:05:06');
  });
});

// ---------------------------------------------------------------------------
// 端到端（mock fetch）：请求头、登录页识别与结果拼装
// ---------------------------------------------------------------------------

describe('fetchRemoteHomework（mock fetch）', () => {
  it('带桌面 UA 请求 stu-work，并解析出作业', async () => {
    const seen: Array<{ url: string; headers: Headers }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      seen.push({ url, headers: new Headers(init?.headers) });
      return new Response(HOMEWORK_HTML, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    });

    const entries = await fetchRemoteHomework(new CookieSession(new CookieJar()), NOW);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(HOMEWORK_URL);
    expect(seen[0]?.headers.get('user-agent')).toContain('Windows NT 10.0');
    expect(entries).toHaveLength(3);
    expect(entries[0]?.status).toBe('pending');
  });

  it('被重定向到 passport 登录页时抛 SessionExpiredError', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === HOMEWORK_URL) {
        return new Response('', {
          status: 302,
          headers: { location: 'https://passport2.chaoxing.com/login?fid=1&refer=/x' },
        });
      }
      return new Response('<html><head><title>用户登录</title></head></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    });

    await expect(fetchRemoteHomework(new CookieSession(new CookieJar()), NOW)).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
  });

  it('HTTP 非 200 抛普通 Error（不是会话失效）', async () => {
    vi.stubGlobal('fetch', async () => new Response('boom', { status: 500 }));
    await expect(fetchRemoteHomework(new CookieSession(new CookieJar()), NOW)).rejects.toThrow(
      /HTTP 500/,
    );
  });

  it('无法跟随的 3xx 也按会话失效处理', async () => {
    // 302 但没有 Location —— CookieSession 跟随不了，直接把它交回来
    vi.stubGlobal('fetch', async () => new Response('', { status: 302 }));
    await expect(fetchRemoteHomework(new CookieSession(new CookieJar()), NOW)).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
  });
});

describe('looksLikeLoginPage', () => {
  it('passport / 登录页标题 / 密码框都能识别', () => {
    expect(looksLikeLoginPage('', 'https://passport2.chaoxing.com/login')).toBe(true);
    expect(looksLikeLoginPage('<title>用户登录</title>', 'https://mooc1-api.chaoxing.com/x')).toBe(true);
    expect(
      looksLikeLoginPage(
        '<form action="/login"><input name="pwd" type="password"/></form> chaoxing',
        'https://mooc1-api.chaoxing.com/x',
      ),
    ).toBe(true);
  });

  it('正常业务页不误判', () => {
    expect(looksLikeLoginPage('<html><body>作业列表</body></html>', HOMEWORK_URL)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

describe('createHomeworkTools', () => {
  it('工具名必须是 query_homework', () => {
    expect(createHomeworkTools().map((tool) => tool.name)).toEqual(['query_homework']);
  });

  it('schema 与 Dart 一致：status / courseName / keyword / forceRefresh', () => {
    const [tool] = createHomeworkTools();
    const schema = tool?.inputSchema as {
      type: string;
      additionalProperties: boolean;
      properties: Record<string, { type: string; enum?: string[]; default?: unknown }>;
    };
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual([
      'courseName',
      'forceRefresh',
      'keyword',
      'status',
    ]);
    expect(schema.properties['status']?.enum).toEqual(['all', 'pending', 'completed', 'archived']);
    expect(schema.properties['status']?.default).toBe('pending');
    expect(tool?.description.trim().length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// 大页面：一次 HTMLRewriter 遍历（CPU 预算 10ms/次的回归护栏）
// ---------------------------------------------------------------------------

describe('大页面解析', () => {
  function bigHomeworkPage(count: number): string {
    const items: string[] = [];
    for (let index = 0; index < count; index++) {
      items.push(`<li onclick="goTask(this)" data="https://mooc1-api.chaoxing.com/mooc-ans/android/mtaskmsgspecial?taskrefId=${index}&courseId=2&clazzId=3">
        <div class="spanImg"><img src="/static/task-work.png"></div>
        <div role="option"><p>第 ${index} 次作业</p><span class="status">未提交</span>
        <span>《课程 ${index}》</span><span>剩余${index % 200}小时34分钟</span></div></li>`);
    }
    return `<!DOCTYPE html><html><body><ul>${items.join('\n')}</ul></body></html>`;
  }

  // 注：workerd 里 performance.now() 在同一轮事件循环内不前进（防侧信道的时间钳制），
  // 因此这里不断言耗时，只保证「一次遍历能把大页面全部解析正确」——
  // 真实作业页通常只有几 KB~几十 KB，这个 fixture 已经是它的十倍量级。
  it('300 条作业（约 100KB）也能在一次遍历里全部解析出来', async () => {
    const html = bigHomeworkPage(300);
    expect(html.length).toBeGreaterThan(90_000);

    const entries = buildHomeworkEntries(await parseHomeworkHtml(html), NOW);
    expect(entries).toHaveLength(300);
    expect(entries[0]?.title).toBe('第 0 次作业');
    expect(entries[299]?.title).toBe('第 299 次作业');
    expect(entries[299]?.courseName).toBe('《课程 299》');
    expect(entries[299]?.rawTimeStr).toBe('剩余99小时34分钟');
    expect(entries.every((entry) => entry.status === 'pending')).toBe(true);
  });
});

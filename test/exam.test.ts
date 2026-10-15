import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectExamDetailText,
  examIdFromUrl,
  EXAM_LIST_URL,
  extractExamDetail,
  fetchExamSchedules,
  isCurrentSemester,
  looksLikeLoginPage,
  parseExamListHtml,
  resolveExamDataUrl,
} from '../src/school/hunau/chaoxing-study';
import { createExamTools } from '../src/tools/exam';
import { CookieJar } from '../src/auth/cookies';
import { CookieSession } from '../src/auth/http';
import { SessionExpiredError } from '../src/auth/session-manager';

const HOST = 'https://mooc1-api.chaoxing.com';

/** 北京时间 2026-05-10 17:00:00 = UTC 09:00 */
const EXAM_1700 = Date.UTC(2026, 4, 10, 9, 0, 0);
/** 北京时间 2026-05-10 19:00:00 = UTC 11:00 */
const EXAM_1900 = Date.UTC(2026, 4, 10, 11, 0, 0);

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 列表解析
// ---------------------------------------------------------------------------

const LIST_HTML = `<!DOCTYPE html><html><body>
<div class="ks_list">
  <ul class="ks_list">
    <li data="/exam-ans/exam/test?taskrefId=1001&examId=2002" title="高等数学期末考试">
      <dt>备选标题一</dt><span class="ks_state">未交</span>
    </li>
    <li data="exam-ans/exam/test?examId=3003">
      <dt>大学英语期中考试</dt><span class="ks_state">已完成</span>
    </li>
    <li data="${HOST}/exam-ans/exam/test?taskrefId=4004">
      <dt>没有状态的考试</dt>
    </li>
    <li data="${HOST}/exam-ans/task-exam?taskrefId=5005">
      <dt>命中多个选择器</dt><span class="ks_state">进行中</span>
    </li>
    <li data=""><dt>没有 data，应被跳过</dt></li>
  </ul>
</div>
<li data="/exam-ans/task-exam?taskrefId=6006">
  <dt>不在 ks_list 里但含 task-exam</dt>
</li>
</body></html>`;

describe('parseExamListHtml', () => {
  it('解析出 id / 标题 / 详情链接 / 状态', async () => {
    const items = await parseExamListHtml(LIST_HTML);

    expect(items.map((item) => item.id)).toEqual(['1001', '3003', '4004', '5005', '6006']);

    const first = items[0];
    // title 属性优先于 dt 文本
    expect(first?.title).toBe('高等数学期末考试');
    // 相对路径补全 host
    expect(first?.dataUrl).toBe(`${HOST}/exam-ans/exam/test?taskrefId=1001&examId=2002`);
    // taskrefId 优先于 examId
    expect(first?.status).toBe('未交');
  });

  it('title 为空时退化为 dt 文本，dt 为空时为空串', async () => {
    const items = await parseExamListHtml(LIST_HTML);
    expect(items[1]?.title).toBe('大学英语期中考试');
    expect(items[1]?.dataUrl).toBe(`${HOST}/exam-ans/exam/test?examId=3003`);
    expect(items[1]?.status).toBe('已完成');
    expect(items[2]?.status).toBe('');
  });

  it('同一元素命中多个选择器时只出现一次（等价 querySelectorAll 去重）', async () => {
    const items = await parseExamListHtml(LIST_HTML);
    expect(items.filter((item) => item.id === '5005')).toHaveLength(1);
  });

  it('data 为空的列表项被跳过', async () => {
    const items = await parseExamListHtml(LIST_HTML);
    expect(items.some((item) => item.title === '没有 data，应被跳过')).toBe(false);
  });

  it('空页面返回空数组', async () => {
    expect(await parseExamListHtml('<html><body>没有考试</body></html>')).toEqual([]);
  });
});

describe('resolveExamDataUrl / examIdFromUrl', () => {
  it('三段式地址补全（照抄 Dart）', () => {
    expect(resolveExamDataUrl('https://x/y')).toBe('https://x/y');
    expect(resolveExamDataUrl('/exam-ans/a')).toBe(`${HOST}/exam-ans/a`);
    expect(resolveExamDataUrl('exam-ans/a')).toBe(`${HOST}/exam-ans/a`);
  });

  it('id 取值顺序：taskrefId -> examId -> 整条链接', () => {
    expect(examIdFromUrl(`${HOST}/x?taskrefId=1&examId=2`)).toBe('1');
    expect(examIdFromUrl(`${HOST}/x?examId=2`)).toBe('2');
    expect(examIdFromUrl(`${HOST}/x?a=1`)).toBe('');
    expect(examIdFromUrl('不是 URL')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 详情解析（考试日期 / 姓名学号）
// ---------------------------------------------------------------------------

const DETAIL_HTML = `<!DOCTYPE html><html><body>
<div class="result_gray_div">
  <p>考试名称：高等数学期末考试</p>
  <p>考试时间：2026-05-10 17:00:00 至 2026-05-10 19:00</p>
  <div id="watermark-wrapper" class="watermark-wrapper"></div>
  <p>姓名：张三 学号：20230001</p>
  <p>最下方又出现一次：2026-05-10 17:00</p>
</div>
</body></html>`;

describe('考试详情解析', () => {
  it('收集容器内所有时间，展示时间取第一个', async () => {
    const collected = await collectExamDetailText(DETAIL_HTML);
    expect(collected.containerFound).toBe(true);
    expect(collected.hasWatermark).toBe(true);

    const detail = extractExamDetail(collected.text);
    expect(detail).not.toBeNull();
    expect(detail?.rawTimeStrs).toEqual([
      '2026-05-10 17:00:00',
      '2026-05-10 19:00',
      '2026-05-10 17:00',
    ]);
    expect(detail?.allTimesMs).toEqual([EXAM_1700, EXAM_1900, EXAM_1700]);
    expect(detail?.displayTimeMs).toBe(EXAM_1700);
    expect(detail?.studentName).toBe('张三');
    expect(detail?.studentId).toBe('20230001');
  });

  it('姓名/学号支持全角冒号，也允许缺失', async () => {
    const collected = await collectExamDetailText(
      '<div class="result_gray_div">2026-05-10 17:00 姓名：李四</div>',
    );
    const detail = extractExamDetail(collected.text);
    expect(detail?.studentName).toBe('李四');
    expect(detail?.studentId).toBe('');
  });

  it('没有任何可解析时间时返回 null（该场考试会被丢弃）', async () => {
    const collected = await collectExamDetailText(
      '<div class="result_gray_div"><p>姓名：张三</p><p>时间待定</p></div>',
    );
    expect(extractExamDetail(collected.text)).toBeNull();
  });

  it('没有 .result_gray_div 时退化为整页文本（对应 Dart 的 watermark 父节点分支）', async () => {
    const html = `<html><body>
      <div id="watermark-wrapper"></div>
      <div class="info">考试时间：2026-06-01 09:00 姓名：王五 学号：20230002</div>
    </body></html>`;
    const collected = await collectExamDetailText(html);
    expect(collected.containerFound).toBe(false);
    expect(collected.hasWatermark).toBe(true);

    const detail = extractExamDetail(collected.text);
    expect(detail?.displayTimeMs).toBe(Date.UTC(2026, 5, 1, 1, 0, 0));
    expect(detail?.studentName).toBe('王五');
  });

  it('日期正则与 Dart 一致：只要「YYYY-MM-DD HH:mm(:ss)」', () => {
    expect(extractExamDetail('2026/05/10 17:00')?.rawTimeStrs ?? []).toEqual([]);
    expect(extractExamDetail('2026-05-10 17:00')?.rawTimeStrs).toEqual(['2026-05-10 17:00']);
    // 非法日期（2 月 30 日）解析失败，因此不进入结果
    expect(extractExamDetail('2026-02-30 10:00')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 学期判定
// ---------------------------------------------------------------------------

describe('isCurrentSemester（移植 SemesterUtils 的无课表分支）', () => {
  // 参考时间：2026-10-14（秋季学期）
  const autumnRef = Date.UTC(2026, 9, 14, 4, 0, 0);

  it('秋季学期：当年 8/1 ~ 次年 2/15', () => {
    expect(isCurrentSemester(Date.UTC(2026, 8, 1, 0, 0, 0), autumnRef)).toBe(true); // 2026-09-01
    expect(isCurrentSemester(Date.UTC(2026, 11, 31, 0, 0, 0), autumnRef)).toBe(true); // 2026-12-31
    expect(isCurrentSemester(Date.UTC(2027, 1, 15, 15, 59, 59), autumnRef)).toBe(true); // 2027-02-15 23:59 北京
    expect(isCurrentSemester(Date.UTC(2026, 6, 1, 0, 0, 0), autumnRef)).toBe(false); // 2026-07-01
  });

  it('春季学期：当年 2/16 ~ 当年 7/31', () => {
    const springRef = Date.UTC(2026, 3, 1, 0, 0, 0); // 2026-04-01
    expect(isCurrentSemester(Date.UTC(2026, 1, 16, 0, 0, 0), springRef)).toBe(true); // 2026-02-16
    expect(isCurrentSemester(Date.UTC(2026, 6, 31, 15, 59, 59), springRef)).toBe(true); // 2026-07-31 23:59 北京
    expect(isCurrentSemester(Date.UTC(2026, 7, 1, 0, 0, 0), springRef)).toBe(false); // 2026-08-01
  });

  it('1 月与 2 月上旬属于上一个秋季学期', () => {
    const janRef = Date.UTC(2027, 0, 5, 0, 0, 0); // 2027-01-05
    expect(isCurrentSemester(Date.UTC(2027, 0, 20, 0, 0, 0), janRef)).toBe(true);
    expect(isCurrentSemester(Date.UTC(2026, 11, 20, 0, 0, 0), janRef)).toBe(true);
    expect(isCurrentSemester(Date.UTC(2026, 9, 1, 0, 0, 0), janRef)).toBe(true); // 2026-10-01 同属 2026 秋
    expect(isCurrentSemester(Date.UTC(2027, 2, 1, 0, 0, 0), janRef)).toBe(false); // 2027-03-01 超出 2/15
  });
});

// ---------------------------------------------------------------------------
// 端到端（mock fetch）：列表 + 详情 + 会话失效
// ---------------------------------------------------------------------------

const DETAIL_A = `<div class="result_gray_div">考试时间：2026-05-10 17:00:00
  <div id="watermark-wrapper"></div>姓名：张三 学号：20230001</div>`;
const DETAIL_B = `<div class="result_gray_div">考试时间：2026-05-11 09:30
  <div id="watermark-wrapper"></div>姓名：张三 学号：20230001</div>`;

function listHtml(): string {
  return `<div class="ks_list"><ul class="ks_list">
    <li data="/exam-ans/exam/test?taskrefId=1001" title="高等数学期末考试"><span class="ks_state">未交</span></li>
    <li data="/exam-ans/exam/test?taskrefId=1002" title="大学英语期末考试"><span class="ks_state">已完成</span></li>
    <li data="/exam-ans/exam/test?taskrefId=1003" title="解析不出时间的考试"><span class="ks_state">未交</span></li>
  </ul></div>`;
}

function stubExams(): string[] {
  const requested: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    requested.push(url);
    const html =
      url === EXAM_LIST_URL
        ? listHtml()
        : url.includes('taskrefId=1001')
          ? DETAIL_A
          : url.includes('taskrefId=1002')
            ? DETAIL_B
            : '<div class="result_gray_div">时间待定</div>';
    return new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  });
  return requested;
}

describe('fetchExamSchedules（mock fetch）', () => {
  it('逐条抓详情并按时间升序返回，解析不出的进 unresolved', async () => {
    const requested = stubExams();
    const result = await fetchExamSchedules(new CookieSession(new CookieJar()));

    expect(requested[0]).toBe(EXAM_LIST_URL);
    expect(requested).toHaveLength(4); // 列表 + 3 条详情

    expect(result.exams.map((exam) => exam.id)).toEqual(['1001', '1002']);
    expect(result.exams[0]?.timeMs).toBe(EXAM_1700);
    expect(result.exams[0]?.status).toBe('未交');
    expect(result.exams[0]?.studentName).toBe('张三');
    expect(result.exams[0]?.rawTimeStrs).toEqual(['2026-05-10 17:00:00']);
    expect(result.exams[1]?.timeMs).toBe(Date.UTC(2026, 4, 11, 1, 30, 0));

    expect(result.unresolved.map((item) => item.id)).toEqual(['1003']);
  });

  it('详情接口失败只丢弃该条，不影响其它考试', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === EXAM_LIST_URL) {
        return new Response(listHtml(), {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      if (url.includes('taskrefId=1001')) return new Response('boom', { status: 500 });
      if (url.includes('taskrefId=1002')) {
        return new Response(DETAIL_B, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      return new Response('<div class="result_gray_div">时间待定</div>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    });

    const result = await fetchExamSchedules(new CookieSession(new CookieJar()));
    expect(result.exams.map((exam) => exam.id)).toEqual(['1002']);
    expect(result.unresolved.map((item) => item.id)).toEqual(['1001', '1003']);
  });

  it('详情页返回登录页时抛 SessionExpiredError（外层会重登重试）', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === EXAM_LIST_URL) {
        return new Response(listHtml(), {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      return new Response('<html><head><title>用户登录</title></head></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    });

    await expect(fetchExamSchedules(new CookieSession(new CookieJar()))).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
  });

  it('考试链路使用超星 App UA（campusCardUA）', async () => {
    let seenUa = '';
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === EXAM_LIST_URL) seenUa = new Headers(init?.headers).get('user-agent') ?? '';
      return new Response('<html><body>没有考试</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    });

    await fetchExamSchedules(new CookieSession(new CookieJar()));
    expect(seenUa).toContain('ChaoXingStudy_1000257');
  });
});

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

describe('createExamTools', () => {
  it('注册 query_exams 与别名 query_exam_schedule', () => {
    const tools = createExamTools();
    expect(tools.map((tool) => tool.name)).toEqual(['query_exams', 'query_exam_schedule']);
  });

  it('别名与主工具共用同一个实现函数，schema 完全一致', () => {
    const [primary, alias] = createExamTools();
    expect(alias?.handler).toBe(primary?.handler);
    expect(alias?.inputSchema).toEqual(primary?.inputSchema);
    expect(alias?.description).toBe(primary?.description);
  });

  it('schema 与 Dart 一致：currentSemesterOnly / keyword / forceRefresh', () => {
    const [tool] = createExamTools();
    const schema = tool?.inputSchema as {
      type: string;
      additionalProperties: boolean;
      properties: Record<string, { type: string; default?: unknown }>;
    };
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual([
      'currentSemesterOnly',
      'forceRefresh',
      'keyword',
    ]);
    expect(schema.properties['currentSemesterOnly']?.type).toBe('boolean');
    expect(schema.properties['currentSemesterOnly']?.default).toBe(true);
  });
});

describe('looksLikeLoginPage（考试链路复用）', () => {
  it('识别登录页', () => {
    expect(looksLikeLoginPage('<html></html>', 'https://passport2.chaoxing.com/login')).toBe(true);
  });

  it('正常考试页不误判', () => {
    expect(looksLikeLoginPage(LIST_HTML, EXAM_LIST_URL)).toBe(false);
  });
});

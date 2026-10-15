import { SELF, fetchMock } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildLeaveFields,
  buildLeaveMultipartForm,
  buildQuestionnaireBody,
  formatLeaveRecord,
  isQuestionnaireSubmitted,
  matchLeaveDict,
  matchQuestionnaire,
  matchRegionNode,
  matchesLeaveStatus,
  parseLeaveDict,
  parseLeaveDuration,
  parseMinuteStamp,
  parseQuestionnaireDetail,
  parseQuestionnaireItems,
  parseRegionNodes,
  postMultipartWithJar,
  questionKind,
  resolveQuestionnaireAnswers,
  sanitizeAttachmentName,
  validateLeaveInput,
  type LeaveDictItem,
  type LeaveRegionNode,
  type LeaveSubmitInput,
  type QuestionnaireDetail,
  type QuestionnaireQuestion,
} from '../src/tools/xgxt';
import { CookieJar } from '../src/auth/cookies';
import { CookieSession } from '../src/auth/http';
import type { SessionContext } from '../src/auth/session-manager';

/**
 * 学工系统「请假 + 问卷提交」纯逻辑与 multipart 单测。
 *
 * 这些用例锁的是**与 Dart 源应用一致的接口契约**（字段名、body 形状、匹配规则），
 * 不是真实服务端行为 —— 真实接口没有账号实测过。
 */

type Validated = LeaveSubmitInput;

function validArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: '事假',
    startTime: '2026-09-22 10:00',
    endTime: '2026-09-22 18:00',
    reason: '家中有事',
    contact: '张老师',
    phone: '13800138000',
    ...overrides,
  };
}

function expectValid(args: Record<string, unknown>): Validated {
  const result = validateLeaveInput(args);
  if (!result.ok) throw new Error(`预期校验通过，实际失败：${result.message}`);
  return result.value;
}

function expectInvalid(args: Record<string, unknown>): string {
  const result = validateLeaveInput(args);
  if (result.ok) throw new Error('预期校验失败，实际通过');
  return result.message;
}

const TYPES: LeaveDictItem[] = [
  { id: 'QJLX01', name: '事假' },
  { id: 'QJLX02', name: '病假' },
];

const REGIONS: LeaveRegionNode[] = [
  {
    id: '430000',
    name: '湖南省',
    children: [
      {
        id: '430100',
        name: '长沙市',
        children: [{ id: '430104', name: '岳麓区', children: [] }],
      },
    ],
  },
  { id: '110000', name: '北京市', children: [] },
];

describe('请假参数校验（validateLeaveInput）', () => {
  it('合法输入被归一化（去首尾空格、布尔位缺省 false）', () => {
    const value = expectValid(validArgs({ type: ' 事假 ', reason: ' 家中有事 ' }));
    expect(value.type).toBe('事假');
    expect(value.reason).toBe('家中有事');
    expect(value.leaveSchool).toBe(false);
    expect(value.backDorm).toBe(false);
    expect(value.confirmed).toBe(false);
    expect(value.attachment).toBeNull();
    expect(value.companions).toBe('');
  });

  it('缺类别 / 事由 / 联系人都被拦下', () => {
    expect(expectInvalid(validArgs({ type: '' }))).toContain('类别');
    expect(expectInvalid(validArgs({ reason: '   ' }))).toContain('事由');
    expect(expectInvalid(validArgs({ contact: '' }))).toContain('紧急联系人');
  });

  it('手机号必须是 11 位（1 开头）', () => {
    expect(expectInvalid(validArgs({ phone: '1380013800' }))).toContain('11 位手机号');
    expect(expectInvalid(validArgs({ phone: '23800138000' }))).toContain('11 位手机号');
    expect(expectInvalid(validArgs({ phone: '138-0013-8000' }))).toContain('11 位手机号');
  });

  it('时间格式与先后顺序都要合法', () => {
    expect(expectInvalid(validArgs({ startTime: '2026/09/22 10:00' }))).toContain('开始时间');
    expect(expectInvalid(validArgs({ endTime: '2026-09-22' }))).toContain('结束时间');
    expect(expectInvalid(validArgs({ endTime: '2026-09-22 10:00' }))).toContain('晚于开始时间');
    expect(expectInvalid(validArgs({ endTime: '2026-09-22 09:59' }))).toContain('晚于开始时间');
  });

  it('离校时省份 / 详细地址 / 备注必填', () => {
    expect(expectInvalid(validArgs({ leaveSchool: true }))).toContain('省份');
    expect(expectInvalid(validArgs({ leaveSchool: true, province: '湖南' }))).toContain('详细地址');
    expect(
      expectInvalid(validArgs({ leaveSchool: true, province: '湖南', address: '长沙市岳麓区' })),
    ).toContain('备注');
    const value = expectValid(
      validArgs({
        leaveSchool: true,
        province: '湖南',
        address: '长沙市岳麓区',
        remark: '回家',
        city: '长沙',
        county: '岳麓',
      }),
    );
    expect(value.leaveSchool).toBe(true);
    expect(value.county).toBe('岳麓');
  });

  it('附件：给了 base64 就必须给文件名，非法 base64 被拦下', () => {
    const base64 = btoa('hello');
    expect(expectInvalid(validArgs({ attachmentBase64: base64 }))).toContain('attachmentName');
    expect(expectInvalid(validArgs({ attachmentBase64: '!!!not-base64!!!' }))).toContain('base64');
    const value = expectValid(
      validArgs({ attachmentBase64: base64, attachmentName: '病历.jpg' }),
    );
    expect(value.attachment?.name).toBe('病历.jpg');
    expect(value.attachment?.bytes.length).toBe(5);
  });

  it('附件上限 1MB（base64 解码是逐字节 JS 循环，要给 10ms CPU 预算留余量）', () => {
    const justRight = btoa('x'.repeat(1024 * 1024));
    expect(
      expectValid(validArgs({ attachmentBase64: justRight, attachmentName: 'ok.bin' })).attachment
        ?.bytes.length,
    ).toBe(1024 * 1024);

    const tooBig = btoa('x'.repeat(1024 * 1024 + 1));
    expect(
      expectInvalid(validArgs({ attachmentBase64: tooBig, attachmentName: 'big.bin' })),
    ).toContain('超过上限');
  });

  it('parseMinuteStamp 只接受合法日期时间', () => {
    expect(parseMinuteStamp('2026-09-22 10:00')).not.toBeNull();
    expect(parseMinuteStamp('2026-09-22 23:59')).not.toBeNull();
    expect(parseMinuteStamp('2026-09-22 24:00')).toBeNull();
    expect(parseMinuteStamp('2026-13-01 10:00')).toBeNull();
    expect(parseMinuteStamp('2026-02-30 10:00')).toBeNull();
    expect(parseMinuteStamp('26-09-22 10:00')).toBeNull();
    expect(parseMinuteStamp('2026-09-22T10:00')).toBeNull();
    // 可比较性：晚的时间戳更大
    expect(parseMinuteStamp('2026-09-22 18:00')!).toBeGreaterThan(
      parseMinuteStamp('2026-09-22 10:00')!,
    );
  });
});

describe('请假类别与地区匹配', () => {
  it('selects 字典解析为 {id, name}', () => {
    expect(parseLeaveDict([{ id: 'QJLX01', text: '事假' }, { id: 'QJLX02', text: '病假' }])).toEqual(
      TYPES,
    );
    expect(parseLeaveDict({ not: 'array' })).toEqual([]);
  });

  it('类别支持 id / 全名 / 关键词匹配', () => {
    expect(matchLeaveDict(TYPES, 'QJLX02')?.name).toBe('病假');
    expect(matchLeaveDict(TYPES, '事假')?.id).toBe('QJLX01');
    expect(matchLeaveDict(TYPES, '病')?.id).toBe('QJLX02');
    expect(matchLeaveDict(TYPES, '婚假')).toBeNull();
    expect(matchLeaveDict(TYPES, '  ')).toBeNull();
  });

  it('省市县树解析与逐级匹配', () => {
    const nodes = parseRegionNodes([
      { id: '430000', text: '湖南省', children: [{ id: '430100', text: '长沙市' }] },
    ]);
    expect(nodes[0].children[0]).toEqual({ id: '430100', name: '长沙市', children: [] });
    expect(matchRegionNode(REGIONS, '湖南')?.id).toBe('430000');
    expect(matchRegionNode(REGIONS[0].children, '长沙')?.id).toBe('430100');
    expect(matchRegionNode(REGIONS[0].children[0].children, '岳麓')?.id).toBe('430104');
    expect(matchRegionNode(REGIONS, '上海')).toBeNull();
  });
});

describe('请假提交字段与 multipart', () => {
  const input = expectValid(
    validArgs({
      companions: '同学甲',
      leaveSchool: true,
      province: '湖南',
      address: '长沙市岳麓区某小区',
      remark: '回家',
      backDorm: true,
      outCity: true,
      outProvince: false,
    }),
  );

  it('字段名/取值与 Dart 申请页一致（含 pathFile 空串与 operationType=Create）', () => {
    const fields = buildLeaveFields(
      input,
      TYPES[1],
      { id: '430104', name: '岳麓区' },
      { days: 1, hours: 2 },
    );
    expect(fields).toEqual({
      'qjlxM.dm': 'QJLX02',
      qjlx: '病假',
      kssj: '2026-09-22 10:00',
      jssj: '2026-09-22 18:00',
      ts: '1',
      jsTs: '1',
      hour: '2',
      jsHour: '2',
      qjsy: '家中有事',
      lxr: '张老师',
      lxrdh: '13800138000',
      txry: '同学甲',
      lxInd: '1',
      'lxqx.dm': '430104',
      lxqx1: '岳麓区',
      lxMdd: '长沙市岳麓区某小区',
      huisusheInd: '1',
      lxBz: '回家',
      chushiInd: '1',
      chushengInd: '0',
      pathFile: '',
      qjLocation: '',
      qjLocationZb: '',
      operationType: 'Create',
      id: '',
    });
    // 键顺序也会进 urlencoded body，这里锁住首尾
    expect(Object.keys(fields)[0]).toBe('qjlxM.dm');
    expect(Object.keys(fields).at(-1)).toBe('id');
  });

  it('multipart：文本字段在前、pathFile 只出现一次且带文件名', async () => {
    const fields = buildLeaveFields(input, TYPES[0], { id: '', name: '' }, { days: 0, hours: 1 });
    const form = buildLeaveMultipartForm(fields, {
      name: '病历.jpg',
      bytes: new TextEncoder().encode('HELLO-BYTES'),
    });

    const keys = [...form.keys()];
    expect(keys.filter((key) => key === 'pathFile')).toHaveLength(1);
    expect(keys[0]).toBe('qjlxM.dm');
    expect(keys.at(-1)).toBe('pathFile');

    const file = form.get('pathFile');
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe('病历.jpg');
    expect((file as File).size).toBe(11);
  });

  it('multipart 二进制内容逐字节保留（含 CRLF 与高位字节）', async () => {
    const bytes = new Uint8Array([0x00, 0x41, 0xff, 0xfe, 0x0d, 0x0a, 0x2d, 0x2d, 0x80]);
    const form = buildLeaveMultipartForm({ qjsy: '病假' }, { name: 'x.bin', bytes });
    const request = new Request('https://xgxt.hunau.edu.cn/x', {
      method: 'POST',
      body: form,
      redirect: 'manual',
    });

    expect(request.headers.get('content-type')).toContain('multipart/form-data; boundary=');
    const raw = new Uint8Array(await request.arrayBuffer());
    const latin = new TextDecoder('latin1').decode(raw);
    const marker = 'Content-Type: application/octet-stream\r\n\r\n';
    const start = latin.indexOf(marker) + marker.length;
    const boundary = latin.slice(2, latin.indexOf('\r\n'));
    const end = latin.indexOf(`\r\n--${boundary}`, start);
    expect(start).toBeGreaterThan(marker.length - 1);
    expect(Array.from(raw.subarray(start, end))).toEqual(Array.from(bytes));
  });

  it('文件名里的换行/引号/路径被清掉', () => {
    expect(sanitizeAttachmentName('病\r\n历".jpg')).toBe('病历.jpg');
    expect(sanitizeAttachmentName('dir/sub/病历.jpg')).toBe('dirsub病历.jpg');
    expect(sanitizeAttachmentName('   ')).toBe('attachment');
  });

  it('postMultipartWithJar：带 Cookie、识别 302、落回新 Cookie', async () => {
    const url = 'https://xgxt.hunau.edu.cn/content/student/leave/apply_stu?_t_s_=1';
    const jar = new CookieJar();
    jar.absorb(url, ['JSESSIONID=old-session; Path=/']);
    const context: SessionContext = {
      session: new CookieSession(jar),
      identity: null,
      didLogin: false,
    };

    let seenCookie = '';
    let seenBody = '';
    fetchMock
      .get('https://xgxt.hunau.edu.cn')
      .intercept({ path: '/content/student/leave/apply_stu?_t_s_=1', method: 'POST' })
      .reply((options) => {
        seenCookie = (options.headers as Record<string, string>)['cookie'] ?? '';
        seenBody = typeof options.body === 'string' ? options.body : '';
        return {
          statusCode: 302,
          data: '',
          responseOptions: { headers: { Location: '/cas/login', 'Set-Cookie': 'JSESSIONID=new; Path=/' } },
        };
      });

    const form = buildLeaveMultipartForm(
      { qjsy: '事假', pathFile: '' },
      { name: 'a.png', bytes: new TextEncoder().encode('PNG-ASCII') },
    );
    const response = await postMultipartWithJar(context, url, form);

    expect(response.status).toBe(302);
    expect(seenCookie).toBe('JSESSIONID=old-session');
    expect(seenBody).toContain('name="qjsy"');
    expect(seenBody).toContain('filename="a.png"');
    expect(seenBody).toContain('PNG-ASCII');
    // pathFile 的空串没有被当成第二个 part 发出去
    expect(seenBody.match(/name="pathFile"/g)).toHaveLength(1);
    // 302 的 Set-Cookie 已经落回罐子
    expect(jar.getCookieHeader(url)).toContain('JSESSIONID=new');
  });
});

describe('请假列表展示', () => {
  const row: Record<string, unknown> = {
    ID: 'L-1',
    LXMC: '事假',
    KSSJ: '2026-09-22 10:00',
    JSSJ: '2026-09-22 18:00',
    TS: 0,
    HOUR: 8,
    QJSY: '家中有事',
    SHZT: '0',
    SHZTMC: '待审核',
    SHJGMC: '',
    HAS_FILE: '1',
  };

  it('列表行格式化（时长/时间区间/可撤销/附件）', () => {
    expect(formatLeaveRecord(row)).toEqual({
      id: 'L-1',
      type: '事假',
      timeRange: '2026-09-22 10:00 ~ 2026-09-22 18:00',
      startTime: '2026-09-22 10:00',
      endTime: '2026-09-22 18:00',
      duration: '8小时',
      reason: '家中有事',
      status: '待审核',
      canDelete: true,
      hasFile: true,
    });
  });

  it('已审核时优先展示 SHZTMC·SHJGMC，且不可撤销', () => {
    const formatted = formatLeaveRecord({
      ...row,
      SHZT: '9',
      SHZTMC: '已审核',
      SHJGMC: '同意',
    });
    expect(formatted['status']).toBe('已审核·同意');
    expect(formatted['canDelete']).toBe(false);
  });

  it('没有 SHZTMC 时按状态码兜底', () => {
    expect(formatLeaveRecord({ ...row, SHZT: '8', SHZTMC: '' })['status']).toBe('审核中');
    expect(formatLeaveRecord({ ...row, SHZT: '9', SHZTMC: '', SHJGMC: '驳回' })['status']).toBe(
      '已审核·驳回',
    );
    expect(formatLeaveRecord({ ...row, SHZT: '7', SHZTMC: '' })['status']).toBe('状态未知');
  });

  it('status 过滤：待审核 / 审核中 / 已审 / 全部', () => {
    expect(matchesLeaveStatus('0', '待审核')).toBe(true);
    expect(matchesLeaveStatus('8', '待审核')).toBe(false);
    expect(matchesLeaveStatus('8', '审核中')).toBe(true);
    expect(matchesLeaveStatus('9', '已审核')).toBe(true);
    expect(matchesLeaveStatus('0', '全部')).toBe(true);
  });

  it('时长解析取 day/hour 并兜底为 0', () => {
    expect(parseLeaveDuration({ day: '1', hour: 2 })).toEqual({ days: 1, hours: 2 });
    expect(parseLeaveDuration({ day: -3, hour: null })).toEqual({ days: 0, hours: 0 });
    expect(parseLeaveDuration({})).toEqual({ days: 0, hours: 0 });
  });
});

describe('问卷提交载荷', () => {
  it('多选题同一个 dm 重复出现，末尾补固定字段', () => {
    const body = buildQuestionnaireBody(
      [
        { dm: 'Q1', values: ['A'] },
        { dm: 'Q2', values: ['B', 'C'] },
        { dm: 'Q3', values: [] },
      ],
      'JG-1',
    );
    expect(body).toBe(
      'Q1=A&Q2=B&Q2=C&Q3=&ks_jgdm=JG-1&wzDz=&wzZb=&wzLy=&operationType=',
    );
  });

  it('中文与空格按 urlencoded 编码', () => {
    expect(buildQuestionnaireBody([{ dm: 'Q1', values: ['是 否'] }], '')).toBe(
      'Q1=%E6%98%AF%20%E5%90%A6&ks_jgdm=&wzDz=&wzZb=&wzLy=&operationType=',
    );
  });

  it('题目 dm 里带点也能原样出现（编码后可被服务端还原）', () => {
    expect(buildQuestionnaireBody([{ dm: 'a.b', values: ['1'] }], '')).toContain('a.b=1&');
  });

  const detail: QuestionnaireDetail = {
    dm: 'WJ-1',
    title: '国庆去向统计',
    jgM: 'JG-9',
    canSubmit: true,
    questions: [
      {
        dm: 'Q1',
        title: '是否离校',
        desc: '',
        stType: '1',
        txType: '',
        required: true,
        answer: '',
        options: [
          { dm: 'A1', name: '是' },
          { dm: 'A2', name: '否' },
        ],
      },
      {
        dm: 'Q2',
        title: '去向',
        desc: '',
        stType: '2',
        txType: '',
        required: false,
        answer: '',
        options: [
          { dm: 'B1', name: '回家' },
          { dm: 'B2', name: '旅游' },
          { dm: 'B3', name: '留校' },
        ],
      },
      {
        dm: 'Q3',
        title: '联系电话',
        desc: '',
        stType: '4',
        txType: '2',
        required: false,
        answer: '',
        options: [],
      },
    ],
  };

  it('按标题关键词与 dm 混合匹配，多选支持数组与顿号文本', () => {
    const result = resolveQuestionnaireAnswers(detail, {
      是否离校: '是',
      Q2: ['回家', '留校'],
      '联系电话': ' 13800138000 ',
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.value.fields).toEqual([
      { dm: 'Q1', values: ['A1'] },
      { dm: 'Q2', values: ['B1', 'B3'] },
      { dm: 'Q3', values: ['13800138000'] },
    ]);
    expect(result.value.preview).toEqual([
      { question: '是否离校', required: true, kind: '单选', answer: '是' },
      { question: '去向', required: false, kind: '多选', answer: ['回家', '留校'] },
      { question: '联系电话', required: false, kind: '电话', answer: '13800138000' },
    ]);

    const byText = resolveQuestionnaireAnswers(detail, { 是否离校: '否', 去向: '回家、旅游' });
    if (!byText.ok) throw new Error(byText.message);
    expect(byText.value.fields[1]).toEqual({ dm: 'Q2', values: ['B1', 'B2'] });
  });

  it('必填选择题没有有效答案时直接失败并列出可选项', () => {
    const result = resolveQuestionnaireAnswers(detail, { 去向: '回家' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('是否离校');
    expect(result.message).toContain('是');
  });

  it('非必填题缺答案提交空值（单选题给一个空串，多选题给一个空串占位）', () => {
    const result = resolveQuestionnaireAnswers(detail, { 是否离校: '否' });
    if (!result.ok) throw new Error(result.message);
    expect(result.value.fields).toEqual([
      { dm: 'Q1', values: ['A2'] },
      { dm: 'Q2', values: [] },
      { dm: 'Q3', values: [] },
    ]);
    expect(buildQuestionnaireBody(result.value.fields, detail.jgM)).toContain('Q2=&Q3=&ks_jgdm=JG-9');
  });

  it('题型判定与 Dart 一致', () => {
    const question = (extra: Partial<QuestionnaireQuestion>): QuestionnaireQuestion => ({
      dm: 'Q',
      title: 'T',
      desc: '',
      stType: '',
      txType: '',
      required: false,
      answer: '',
      options: [],
      ...extra,
    });
    expect(questionKind(question({ stType: '1' }))).toBe('单选');
    expect(questionKind(question({ stType: '2' }))).toBe('多选');
    expect(questionKind(question({ stType: '4', txType: '1' }))).toBe('填空');
    expect(questionKind(question({ stType: '4', txType: '2' }))).toBe('电话');
    expect(questionKind(question({ stType: '4', txType: '3' }))).toBe('日期');
  });
});

describe('问卷列表与详情解析', () => {
  const listPayload = {
    aaData: [
      {
        DM: 'WJ-1',
        MC: '国庆去向统计',
        KSSJ: '2026-09-28 08:00',
        JSSJ: '2026-10-08 23:59',
        TASK_TIME_M: 'T-1',
        DONE_IND: '0',
        ZT: '1',
        SHZT: '0',
      },
    ],
  };

  it('列表解析与匹配（taskTimeM / dm / 标题关键词）', () => {
    const items = parseQuestionnaireItems(listPayload);
    expect(items).toHaveLength(1);
    expect(matchQuestionnaire(items, 'T-1')?.title).toBe('国庆去向统计');
    expect(matchQuestionnaire(items, 'WJ-1')?.taskTimeM).toBe('T-1');
    expect(matchQuestionnaire(items, '国庆')?.taskTimeM).toBe('T-1');
    expect(matchQuestionnaire(items, '中秋')).toBeNull();
    expect(isQuestionnaireSubmitted(items[0])).toBe(true);
    expect(parseQuestionnaireItems({})).toEqual([]);
  });

  it('详情解析 stList / canSubmit / jgM', () => {
    const detail = parseQuestionnaireDetail({
      dm: 'WJ-1',
      mc: '国庆去向统计',
      jgM: 'JG-9',
      canSubmit: '0',
      stList: [
        {
          dm: 'Q1',
          stmc: '是否离校',
          btInd: '1',
          stType: '1',
          stxxList: [{ dm: 'A1', mc: '是' }],
        },
      ],
    });
    expect(detail.canSubmit).toBe(false);
    expect(detail.jgM).toBe('JG-9');
    expect(detail.questions[0]).toEqual({
      dm: 'Q1',
      title: '是否离校',
      desc: '',
      stType: '1',
      txType: '',
      required: true,
      answer: '',
      options: [{ dm: 'A1', name: '是' }],
    });
    // canSubmit 缺失时按可提交处理（Dart 的默认值）
    expect(parseQuestionnaireDetail({ dm: 'x' }).canSubmit).toBe(true);
  });
});

describe('MCP 层冒烟：新工具已注册且参数校验可达（不触网）', () => {
  const CREDENTIAL_HEADERS = {
    'Content-Type': 'application/json',
    'X-OA-Id': '20230001',
    'X-OA-Key': 'not-a-real-password',
  };

  async function callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean }> {
    const response = await SELF.fetch(
      new Request('https://mcp.test/mcp', {
        method: 'POST',
        headers: CREDENTIAL_HEADERS,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      }),
    );
    const body = (await response.json()) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    return { text: body.result.content[0].text, isError: body.result.isError === true };
  }

  it('缺参数时先返回中文提示，不会去碰网络', async () => {
    const leave = await callTool('submit_leave', {});
    expect(leave.isError).toBe(false);
    expect(leave.text).toContain('请假类别');

    const detail = await callTool('query_leave_detail', {});
    expect(detail.text).toContain('请假记录 id');

    const questionnaire = await callTool('submit_questionnaire', {});
    expect(questionnaire.text).toContain('问卷标题关键词');

    const badAnswers = await callTool('submit_questionnaire', {
      questionnaire: '国庆',
      answers: 'not-an-object',
    });
    expect(badAnswers.text).toContain('answers');
  });
});

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterAll(() => {
  fetchMock.deactivate();
  fetchMock.enableNetConnect();
});

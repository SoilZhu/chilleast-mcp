import { describe, expect, it } from 'vitest';
import { SessionExpiredError } from '../src/auth/session-manager';
import {
  DEPT_ID_ENC,
  LibraryError,
  PIXEL9_UA,
  buildEncSource,
  extractSubmitEnc,
  fullRoomName,
  generateEnc,
  parseSeatReserve,
  parseSeatResponse,
  reserveStatusLabel,
} from '../src/school/hunau/library';
import {
  buildBookDetail,
  buildBookFromRaw,
  buildBooks,
  effectiveCatalogItems,
  holdingIsAvailable,
  isCallNumber,
  isDocType,
  isIsbn,
  isLanguage,
  isPublisher,
  isYear,
  parseBookDetailPage,
  parseSearchPage,
  totalCountFromTexts,
  totalPagesFromTexts,
  type RawBookListItem,
} from '../src/school/hunau/library-book';
import {
  availableReserveDays,
  availableStartSlots,
  buildTimeSlots,
  dateTimeAt,
  defaultEndTime,
  defaultStartTime,
  formatDayLabel,
  formatHourMinute,
  isValidRange,
  normalizeFloor,
  todayString,
} from '../src/school/hunau/library-time';
import { createLibraryTools, LIBRARY_TOOL_NAMES } from '../src/tools/library';

// ---------------------------------------------------------------------------
// 1. 座位预约签名（Dart `_generateEnc`）
// ---------------------------------------------------------------------------

describe('座位预约签名 _generateEnc', () => {
  const submitEnc = 's3cr3t-enc-value';
  const normalParams = {
    deptIdEnc: DEPT_ID_ENC,
    roomId: 36187,
    day: '2026-10-15',
    startTime: '08:30',
    endTime: '10:30',
    seatNum: '034',
    captcha: '',
    wyToken: '',
  };

  it('拼串规则：key 字典序 + [k=v] + 末尾 [submit_enc]', () => {
    expect(buildEncSource(normalParams, submitEnc)).toBe(
      '[captcha=][day=2026-10-15][deptIdEnc=4dc85b11270eab26][endTime=10:30]' +
        '[roomId=36187][seatNum=034][startTime=08:30][wyToken=][s3cr3t-enc-value]',
    );
  });

  it('MD5 结果与外部实现（python hashlib）一致', () => {
    expect(generateEnc(normalParams, submitEnc)).toBe(
      '805882f3241be2a18d2e6cffac5d2adf',
    );
  });

  it('快速预约的参数集合不含 deptIdEnc，签名与普通预约不同', () => {
    const quickParams = {
      roomId: 36187,
      startTime: '08:30',
      endTime: '10:30',
      day: '2026-10-15',
      captcha: '',
      seatNum: '034',
      wyToken: '',
    };
    expect(buildEncSource(quickParams, 'LIVE-ENC')).toBe(
      '[captcha=][day=2026-10-15][endTime=10:30][roomId=36187][seatNum=034]' +
        '[startTime=08:30][wyToken=][LIVE-ENC]',
    );
    expect(generateEnc(quickParams, 'LIVE-ENC')).toBe('a941f536867ebf5363a5baf731bdda0f');
    expect(generateEnc(quickParams, 'LIVE-ENC')).not.toBe(generateEnc(normalParams, submitEnc));
  });

  it('参数对象构造顺序不影响签名（内部排序）', () => {
    const reordered = {
      wyToken: '',
      seatNum: '034',
      startTime: '08:30',
      endTime: '10:30',
      day: '2026-10-15',
      roomId: 36187,
      captcha: '',
      deptIdEnc: DEPT_ID_ENC,
    };
    expect(generateEnc(reordered, submitEnc)).toBe(generateEnc(normalParams, submitEnc));
  });

  it('submit_enc 不同则签名不同（不会忽略页面凭证）', () => {
    expect(generateEnc(normalParams, 'other')).not.toBe(generateEnc(normalParams, submitEnc));
  });
});

// ---------------------------------------------------------------------------
// 2. 从选座页/快速预约页抓 submit_enc
// ---------------------------------------------------------------------------

describe('submit_enc 抓取', () => {
  it('优先读 input#submit_enc 的 value 属性', async () => {
    const html = `<html><body><form>
      <input type="hidden" id="submit_enc" value="abc123"/>
      <input type="hidden" id="other" value="zzz"/>
    </form></body></html>`;
    expect(await extractSubmitEnc(html, '取不到')).toBe('abc123');
  });

  it('属性顺序不同（value 在前）时正则兜底也能取到', async () => {
    const html = '<input value="xyz" id="submit_enc">';
    expect(await extractSubmitEnc(html, '取不到')).toBe('xyz');
  });

  it('跳到超星登录页时抛会话失效，而不是业务错误', async () => {
    const html =
      '<!doctype html><html><head><title>登录</title></head>' +
      '<body><form action="https://passport2.chaoxing.com/mlogin"></form></body></html>';
    await expect(extractSubmitEnc(html, '取不到')).rejects.toThrow(SessionExpiredError);
  });

  it('页面结构变化时给业务错误', async () => {
    await expect(extractSubmitEnc('<html><body>nothing</body></html>', '取不到')).rejects.toThrow(
      LibraryError,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. 座位接口响应解析（JSON vs 登录页 HTML）
// ---------------------------------------------------------------------------

describe('座位响应解析', () => {
  it('success=true 时返回解析结果', () => {
    const parsed = parseSeatResponse('{"success":true,"data":{"levels":[]}}', '失败');
    expect(parsed['success']).toBe(true);
  });

  it('success 不为 true 时抛出服务端 msg（业务错误，不该触发重登）', () => {
    expect(() => parseSeatResponse('{"success":false,"msg":"座位已被占用"}', '失败')).toThrow(
      '座位已被占用',
    );
    expect(() => parseSeatResponse('{"success":false,"msg":"座位已被占用"}', '失败')).toThrow(
      LibraryError,
    );
  });

  it('JSON 形式的「未登录」要识别成会话失效（实测：office.chaoxing.com 未登录返回 200 + 这段 JSON）', () => {
    // 线上原样返回：{"msg":"您当前未登录","success":false}
    expect(() => parseSeatResponse('{"msg":"您当前未登录","success":false}', '失败')).toThrow(
      SessionExpiredError,
    );
    expect(() => parseSeatResponse('{"msg":"登录已过期","success":false}', '失败')).toThrow(
      SessionExpiredError,
    );
  });

  it('返回 HTML 页面时抛 SessionExpiredError（Dart 原话是「登录会话已过期」）', () => {
    expect(() => parseSeatResponse('<html><body>login</body></html>', '失败')).toThrow(
      SessionExpiredError,
    );
    // 明确的超星 passport 登录页会走到更精确的分支
    expect(() =>
      parseSeatResponse('<html><title>登录</title><body>passport2.chaoxing.com</body></html>', '失败'),
    ).toThrow(SessionExpiredError);
  });

  it('返回其它非 JSON 内容时给业务错误', () => {
    expect(() => parseSeatResponse('502 Bad Gateway', '获取失败')).toThrow(LibraryError);
  });

  it('预约记录字段解析（时间戳 / 房间名 / 状态）', () => {
    const reserve = parseSeatReserve({
      id: '123',
      roomId: 36187,
      deptId: 33430,
      seatNum: '034',
      startTime: 1760488200000,
      endTime: 1760495400000,
      status: 1,
      firstLevelName: '图书馆',
      secondLevelName: '2楼',
      thirdLevelName: '301',
      today: '2026-10-15',
      duration: '2',
    });
    expect(reserve.id).toBe(123);
    expect(reserve.seatNum).toBe('034');
    expect(fullRoomName(reserve)).toBe('图书馆 · 2楼 · 301');
    expect(reserveStatusLabel(reserve.status)).toBe('使用中');
    expect(reserveStatusLabel(0)).toBe('待签到');
    expect(reserveStatusLabel(99)).toBe('未知');
  });

  it('座位系统 UA 常量与 Dart 写死的 Pixel 9 一致', () => {
    expect(PIXEL9_UA).toContain('Pixel 9');
    expect(PIXEL9_UA).toContain('Chrome/151.0.0.0 Mobile Safari/537.36');
    expect(DEPT_ID_ENC).toBe('4dc85b11270eab26');
  });
});

// ---------------------------------------------------------------------------
// 4. 书目字段启发式（服务端标签整体错位，只能按格式猜）
// ---------------------------------------------------------------------------

describe('书目字段启发式', () => {
  it('isIsbn：8 位以上纯数字（可含 X），带连字符/空格也算', () => {
    expect(isIsbn('7-03-002194-0')).toBe(true);
    expect(isIsbn('978-7-109-32084-0')).toBe(true);
    expect(isIsbn('080442957X')).toBe(true);
    expect(isIsbn('S47-61/1')).toBe(false);
    expect(isIsbn('空')).toBe(false);
    expect(isIsbn('2024')).toBe(false); // 位数不够
    expect(isIsbn('')).toBe(false);
  });

  it('isCallNumber：含 / 或 字母数字+分隔符 的混排', () => {
    expect(isCallNumber('S47-61/1')).toBe(true);
    expect(isCallNumber('S511.029.2-64/1')).toBe(true);
    expect(isCallNumber('TP312JA/1')).toBe(true);
    expect(isCallNumber('7-03-002194-0')).toBe(false); // ISBN 优先
    expect(isCallNumber('中国水稻害虫天敌名录')).toBe(false);
    expect(isCallNumber('')).toBe(false);
  });

  it('isPublisher：出版机构关键词或「城市:出版社」写法', () => {
    expect(isPublisher('北京:中国农业出版社')).toBe(true);
    expect(isPublisher('中国农业出版社')).toBe(true);
    expect(isPublisher('中华书局')).toBe(true);
    expect(isPublisher('http://example.com')).toBe(false);
    expect(isPublisher('M')).toBe(false);
    expect(isPublisher('水稻')).toBe(false);
  });

  it('isDocType / isLanguage：滤掉文献类型与语种代码', () => {
    for (const code of ['M', 'B', 'C', 'J', 'D', 'R', 'S', 'P', 'm']) {
      expect(isDocType(code)).toBe(true);
    }
    expect(isDocType('水稻')).toBe(false);
    for (const code of ['chi', 'eng', 'CHI ENG', 'jpn', 'und']) {
      expect(isLanguage(code)).toBe(true);
    }
    expect(isLanguage('chi eng jpn')).toBe(false);
  });

  it('isYear：19xx/20xx，且不能把 ISBN 当成出版年', () => {
    expect(isYear('1991.4')).toBe(true);
    expect(isYear('2024')).toBe(true);
    expect(isYear('7-03-002194-0')).toBe(false); // 是 ISBN
    expect(isYear('空')).toBe(false);
    expect(isYear('S47-61/1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. 列表项装配（真实页面数据）
// ---------------------------------------------------------------------------

/** 真实线上页面的第 1 条（含「信息：」汇总行）。 */
function liveItemOne(): RawBookListItem {
  return {
    detailParam: '{"marc_no":"zyl0003574"}',
    mainKey: '',
    titleAttr: '中国水稻害虫天敌名录农业部全国植物保护总站，农业部区划局，浙江农业大学植物保护系 编',
    titleText: '中国水稻害虫天敌名录农业部全国植物保护总站，农业部区划局，浙江农业大学植物保护系 编',
    authorAttr: '中国水稻害虫天敌名录',
    publisherAttr: 'M',
    paragraphs: [
      '作者：中国水稻害虫天敌名录',
      '索书号：空',
      'ISBN：S47-61/1',
      '出版社：M',
      '出版时间：7-03-002194-0',
      '信息：1 中国水稻害虫天敌名录 农业部全国植物保护总站，农业部区划局，浙江农业大学植物保护系 编 空 M S47-61/1 7-03-002194-0 eng chi 1991.4',
    ],
  };
}

describe('列表项装配', () => {
  it('Case 1（带「信息：」汇总行）：按位置取作者、按格式取索书号/ISBN/出版年', () => {
    const book = buildBookFromRaw(liveItemOne());
    expect(book).not.toBeNull();
    expect(book?.detailParam).toBe('{"marc_no":"zyl0003574"}');
    expect(book?.title).toBe(
      '中国水稻害虫天敌名录农业部全国植物保护总站，农业部区划局，浙江农业大学植物保护系 编',
    );
    // 作者取汇总行的第 3 个 token；title/author 两个 input 在这里其实是错位的（author 存的是题名）
    expect(book?.author).toBe('农业部全国植物保护总站，农业部区划局，浙江农业大学植物保护系');
    expect(book?.callNumber).toBe('S47-61/1');
    expect(book?.isbn).toBe('7-03-002194-0');
    expect(book?.publishYear).toBe('1991.4');
    // 该书的汇总行里没有出版机构 token，Dart 同样取不到
    expect(book?.publisher).toBe('');
    expect(book?.rawInfo).toContain('中国水稻害虫天敌名录');
  });

  it('Case 1 的另一条真实数据：汇总行里带「北京:中国农业出版社」', () => {
    const book = buildBookFromRaw({
      detailParam: '{"marc_no":"zyl0011276"}',
      mainKey: '',
      titleAttr: '江西省水稻地方品种图志余丽琴主编',
      titleText: '江西省水稻地方品种图志余丽琴主编',
      authorAttr: '江西省水稻地方品种图志',
      publisherAttr: 'M',
      paragraphs: [
        '作者：江西省水稻地方品种图志',
        'ISBN：S511.029.2-64/1',
        '出版时间：978-7-109-32084-0',
        '信息：20 江西省水稻地方品种图志 余丽琴主编 水稻 M S511.029.2-64/1 北京:中国农业出版社 978-7-109-32084-0 chi 2024',
      ],
    });
    expect(book?.author).toBe('余丽琴主编');
    expect(book?.callNumber).toBe('S511.029.2-64/1');
    expect(book?.publisher).toBe('北京:中国农业出版社');
    expect(book?.isbn).toBe('978-7-109-32084-0');
    expect(book?.publishYear).toBe('2024');
  });

  it('Case 2（无「信息：」行）：靠启发式把错位的列名纠正回来', () => {
    const book = buildBookFromRaw({
      detailParam: '{"marc_no":"case2001"}',
      mainKey: '',
      titleAttr: '水稻栽培学',
      titleText: '',
      authorAttr: '水稻栽培学',
      // input 里的 publisher 其实是索书号
      publisherAttr: 'S511/1',
      paragraphs: [
        '作者：水稻栽培学',
        '索书号：空',
        'ISBN：978-7-109-32084-0',
        '出版社：北京:中国农业出版社',
        '出版时间：2024',
      ],
    });
    expect(book?.title).toBe('水稻栽培学');
    expect(book?.author).toBe('水稻栽培学');
    expect(book?.callNumber).toBe('S511/1');
    expect(book?.publisher).toBe('北京:中国农业出版社');
    expect(book?.isbn).toBe('978-7-109-32084-0');
    expect(book?.publishYear).toBe('2024');
  });

  it('「空」被当成缺失值，不会变成作者名', () => {
    const book = buildBookFromRaw({
      detailParam: '{"marc_no":"empty001"}',
      mainKey: '',
      titleAttr: '无作者的书',
      titleText: '',
      authorAttr: '',
      publisherAttr: '',
      paragraphs: ['作者：空', '出版社：空', 'ISBN：空'],
    });
    expect(book?.author).toBe('');
    expect(book?.publisher).toBe('');
    expect(book?.isbn).toBe('');
  });

  it('没有 detailParam 的记录直接丢弃', () => {
    const books = buildBooks([
      { ...liveItemOne(), detailParam: '   ' },
      liveItemOne(),
    ]);
    expect(books.length).toBe(1);
  });

  it('总数与总页数解析（真实页面：共806条搜索结果 / 1/41）', () => {
    expect(totalCountFromTexts('共806条搜索结果', '共806条搜索结果')).toBe(806);
    expect(totalCountFromTexts('', '共806条搜索结果')).toBe(806);
    expect(totalCountFromTexts('', '')).toBe(0);
    expect(totalPagesFromTexts(['1/41', '2/41'], 806)).toBe(41);
    // 没有下拉框时按每页 20 条估算
    expect(totalPagesFromTexts([], 806)).toBe(41);
    expect(totalPagesFromTexts([], 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. HTMLRewriter 解析（真实页面结构）
// ---------------------------------------------------------------------------

const SEARCH_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>检索列表</title></head>
<body><div class="resoult"><section id="content"><div class="content">
  <header><div class="num"><h1 style="display:  ;">共806条搜索结果</h1></div></header>
  <form action="/search/bookDetail" id='form1' method="post">
    <div class="list"><ul>
      <li>
        <input type="hidden" disabled="disabled" name="detailParam" value='{"marc_no":"zyl0003574"}'/>
        <input type="hidden" disabled="disabled" name="mainKey" value=''/>
        <input type="hidden" disabled="disabled" name="title" value='中国水稻害虫天敌名录农业部全国植物保护总站，农业部区划局，浙江农业大学植物保护系 编'/>
        <input type="hidden" disabled="disabled" name="author" value='中国水稻害虫天敌名录'/>
        <input type="hidden" disabled="disabled" name="publisher" value='M'/>
        <input type="hidden" disabled="disabled" name="language" value=''/>
        <a href="javascript:void(0)" class="result">
          <div class="title"><span>中国水稻害虫天敌名录农业部全国植物保护总站，农业部区划局，浙江农业大学植物保护系 编</span></div>
          <div class="detail">
            <p>作者：中国水稻害虫天敌名录</p>
            <p>索书号：空</p>
            <p>ISBN：S47-61/1</p>
            <p>出版社：M</p>
            <p>出版时间：7-03-002194-0</p>
            <!-- 其他自定义信息 -->
            <p>信息：1 中国水稻害虫天敌名录 农业部全国植物保护总站，农业部区划局，浙江农业大学植物保护系 编 空 M S47-61/1 7-03-002194-0 eng chi 1991.4</p>
          </div>
        </a>
      </li>
      <li>
        <input type="hidden" disabled="disabled" name="detailParam" value=''/>
        <input type="hidden" disabled="disabled" name="title" value='没有详情参数的书'/>
        <div class="detail"><p>信息：2 没有详情参数的书 X 空 M A/1 1-2-3 X eng 2001</p></div>
      </li>
    </ul></div>
  </form>
</div></section></div>
<div class="foot clearfix" align="center"><footer>
  <select id="pagenum" style="border:none">
    <option value="#" selected="selected">1/41</option>
    <option value="/search/searchList?kw=x&amp;pageIndex=2">2/41</option>
  </select>
</footer></div>
</body></html>`;

describe('检索列表页解析（HTMLRewriter）', () => {
  it('一次遍历同时抽出书目、总数与总页数', async () => {
    const page = await parseSearchPage(SEARCH_HTML);
    expect(page.items.length).toBe(2);
    expect(page.items[0].detailParam).toBe('{"marc_no":"zyl0003574"}');
    expect(page.items[0].titleText).toContain('中国水稻害虫天敌名录');
    expect(page.items[0].paragraphs).toContain('索书号：空');
    expect(page.countText).toBe('共806条搜索结果');
    expect(page.pageTexts).toEqual(['1/41', '2/41']);
  });

  it('解析出的图书列表与总数一致，且跳过无 detailParam 的条目', async () => {
    const page = await parseSearchPage(SEARCH_HTML);
    const books = buildBooks(page.items);
    expect(books.length).toBe(1);
    expect(books[0].isbn).toBe('7-03-002194-0');
    expect(totalCountFromTexts(page.countText, page.numText)).toBe(806);
    expect(totalPagesFromTexts(page.pageTexts, 806)).toBe(41);
  });
});

const DETAIL_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>图书详情</title></head>
<body><div class="article"><article>
  <header><div class="tit text_over_hidden">
    <h1>中国水稻害虫天敌名录 / 农业部全国植物保护总站，农业部区划局，浙江农业大学植物保护系 编</h1>
  </div></header>
  <div class="catalog">
    <p>题名/责任者：中国水稻害虫天敌名录 / 农业部全国植物保护总站，农业部区划局，浙江农业大学植物保护系 编</p>
    <p>ISBN号/定价：7-03-002194-0 / 16元</p>
    <p>出版项：1991.4</p>
    <p>主题词/索书号：/ S47-61/1</p>
    <p>载体形态：pp</p>
    <p>自定义字段：随便什么</p>
  </div>
  <div class="tableLib"><div class="titBox clearfix biao"><p>《中国水稻害虫天敌名录》</p></div>
    <div class="tableCon" style="display:block;">
      <table cellpadding="0" cellspacing="0">
        <tr><th>条码号</th><td>00196323</td></tr>
        <tr><th>卷册号</th><td></td></tr>
        <tr><th>拒借</th><td></td></tr>
        <tr><th>登录号</th><td>378320</td></tr>
        <tr><th>单册类型</th><td>工具书</td></tr>
        <tr><th>状态</th><td>在库</td></tr>
        <tr><th>单价</th><td>16</td></tr>
        <tr><th>馆藏单位</th><td>湖南农业大学图书馆</td></tr>
        <tr><th>典藏地</th><td>中外文工具书阅览区</td></tr>
      </table>
    </div>
  </div>
  <div class="tableLib"><div class="tableCon">
      <table>
        <tr><th>条码号</th><td>00196328</td></tr>
        <tr><th>状态</th><td>借出</td></tr>
        <tr><th>馆藏单位</th><td>湖南农业大学文渊馆</td></tr>
        <tr><th>典藏地</th><td>社会科学图书阅览二区</td></tr>
      </table>
  </div></div>
  <div class="tableLib"><div class="tableCon">
      <table>
        <tr><th>条码号</th><td>馆藏单位</td></tr>
        <tr><th>卷册号</th><td>单册类型</td></tr>
        <tr><th>登录号</th><td>典藏地</td></tr>
        <tr><th>单册类型</th><td>到书时间</td></tr>
        <tr><th>状态</th><td></td></tr>
        <tr><th>单价</th><td>解约时间</td></tr>
        <tr><th>馆藏单位</th><td>卷册号</td></tr>
        <tr><th>典藏地</th><td>预约时间</td></tr>
      </table>
  </div></div>
</article></div></body></html>`;

describe('图书详情页解析（HTMLRewriter）', () => {
  it('书目字段 + 馆藏副本（过滤占位模板表）', async () => {
    const raw = await parseBookDetailPage(DETAIL_HTML);
    expect(raw.titleText).toContain('中国水稻害虫天敌名录 /');
    expect(raw.paragraphs.length).toBe(6);
    expect(raw.tables.length).toBe(3);

    const detail = buildBookDetail(raw);
    expect(detail.title).toBe('中国水稻害虫天敌名录');
    expect(detail.author).toBe('农业部全国植物保护总站，农业部区划局，浙江农业大学植物保护系 编');
    expect(detail.isbn).toBe('7-03-002194-0');
    expect(detail.price).toBe('16元');
    expect(detail.publishInfo).toBe('1991.4');
    expect(detail.callNumber).toBe('S47-61/1');
    expect(detail.subject).toBe('');
    expect(detail.physicalDesc).toBe('pp');
    expect(detail.additionalInfo).toContain('自定义字段：随便什么');

    // 三张表里最后一张是占位模板表，必须被丢掉
    expect(detail.holdings.length).toBe(2);
    expect(detail.holdings[0]).toEqual({
      barcode: '00196323',
      volume: '',
      accessionNo: '378320',
      copyType: '工具书',
      status: '在库',
      price: '16',
      holdingUnit: '湖南农业大学图书馆',
      location: '中外文工具书阅览区',
      notes: '',
    });
    expect(holdingIsAvailable(detail.holdings[0])).toBe(true);
    expect(holdingIsAvailable(detail.holdings[1])).toBe(false);
    expect(detail.holdings.filter(holdingIsAvailable).length).toBe(1);
  });

  it('目录项为空时用已解析字段拼一份（effectiveCatalogItems）', () => {
    const items = effectiveCatalogItems({
      title: '水稻栽培学',
      author: '张三',
      callNumber: 'S511/1',
      subject: '',
      isbn: '978-7-109-32084-0',
      price: '58元',
      publishInfo: '北京:中国农业出版社,2024',
      physicalDesc: '',
      series: '',
      summary: '',
      additionalInfo: [],
      catalogItems: [],
      holdings: [],
    });
    expect(items).toEqual([
      { label: '题名/责任者', value: '水稻栽培学 / 张三' },
      { label: 'ISBN号/定价', value: '978-7-109-32084-0 / 58元' },
      { label: '出版项', value: '北京:中国农业出版社,2024' },
      { label: '主题词/索书号', value: 'S511/1' },
    ]);
  });

  it('目录项非空时原样返回', () => {
    const catalog = [{ label: '题名/责任者', value: 'x / y' }];
    expect(
      effectiveCatalogItems({
        title: '',
        author: '',
        callNumber: '',
        subject: '',
        isbn: '',
        price: '',
        publishInfo: '',
        physicalDesc: '',
        series: '',
        summary: '',
        additionalInfo: [],
        catalogItems: catalog,
        holdings: [],
      }),
    ).toBe(catalog);
  });

  it('馆藏表里没有条码/典藏地/状态的行被丢弃', async () => {
    const raw = await parseBookDetailPage(
      '<div class="tableLib"><div class="tableCon"><table><tr><th>卷册号</th><td>1</td></tr></table></div></div>',
    );
    expect(buildBookDetail(raw).holdings.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. 时间逻辑（全部按北京时间 UTC+8）
// ---------------------------------------------------------------------------

describe('图书馆时间逻辑（北京时间）', () => {
  it('半小时刻度：07:00 起、22:00 止，共 31 个', () => {
    const slots = buildTimeSlots();
    expect(slots.length).toBe(31);
    expect(slots[0]).toBe('07:00');
    expect(slots[1]).toBe('07:30');
    expect(slots[29]).toBe('21:30');
    expect(slots[30]).toBe('22:00');
  });

  it('可预约日期：北京时间 22:00 之前只有今天，之后才有明天', () => {
    // UTC 03:00 = 北京 11:00
    expect(availableReserveDays(new Date('2026-10-14T03:00:00Z'))).toEqual(['2026-10-14']);
    // UTC 13:59 = 北京 21:59
    expect(availableReserveDays(new Date('2026-10-14T13:59:00Z'))).toEqual(['2026-10-14']);
    // UTC 14:00 = 北京 22:00
    expect(availableReserveDays(new Date('2026-10-14T14:00:00Z'))).toEqual([
      '2026-10-14',
      '2026-10-15',
    ]);
  });

  it('日期标签：今天 / 明天 / 星期几', () => {
    const now = new Date('2026-10-14T03:00:00Z'); // 北京 2026-10-14 11:00
    expect(formatDayLabel('2026-10-14', now)).toBe('今天 (10月14日)');
    expect(formatDayLabel('2026-10-15', now)).toBe('明天 (10月15日)');
    expect(formatDayLabel('2026-10-16', now)).toBe('周五 (10月16日)');
    expect(formatDayLabel('bad-input', now)).toBe('bad-input');
    expect(todayString(now)).toBe('2026-10-14');
  });

  it('dateTimeAt：把「日期 + 时刻」当成北京时间的墙上时钟', () => {
    expect(dateTimeAt('2026-10-14', '08:30')).toBe(Date.UTC(2026, 9, 14, 8, 30));
    expect(dateTimeAt('2026-10-14', '8:30')).toBe(Date.UTC(2026, 9, 14, 8, 30));
    expect(dateTimeAt('2026-14-14', '08:30')).toBeNull();
    expect(dateTimeAt('2026-10-14', '25:00')).toBeNull();
    expect(dateTimeAt('2026-10-14', 'nope')).toBeNull();
  });

  it('可约开始时间必须严格晚于此刻（今天）', () => {
    const now = new Date('2026-10-14T00:30:00Z'); // 北京 08:30
    const slots = availableStartSlots('2026-10-14', now);
    expect(slots[0]).toBe('09:00');
    expect(slots).not.toContain('08:30');
    // 明天则所有刻度都可选
    expect(availableStartSlots('2026-10-15', now)[0]).toBe('07:00');
  });

  it('默认开始时段：今天取最近的一个，未来日期优先 08:00', () => {
    const now = new Date('2026-10-14T00:30:00Z'); // 北京 08:30
    expect(defaultStartTime('2026-10-14', now)).toBe('09:00');
    expect(defaultStartTime('2026-10-15', now)).toBe('08:00');
    // 22:00 之后今天已无可用时段
    expect(defaultStartTime('2026-10-14', new Date('2026-10-14T14:30:00Z'))).toBeNull();
  });

  it('默认结束时段 = 开始 + 2 小时，封顶 22:00', () => {
    expect(defaultEndTime('08:30')).toBe('10:30');
    expect(defaultEndTime('20:30')).toBe('22:00');
    expect(defaultEndTime('22:00')).toBeNull();
    expect(defaultEndTime('07:00')).toBe('09:00');
  });

  it('isValidRange：刻度/先后/是否已过 三重校验', () => {
    const now = new Date('2026-10-14T00:00:00Z'); // 北京 08:00
    expect(isValidRange('2026-10-14', '08:30', '10:30', now)).toBe(true);
    expect(isValidRange('2026-10-14', '08:00', '10:00', now)).toBe(false); // 不晚于此刻
    expect(isValidRange('2026-10-14', '10:30', '09:00', now)).toBe(false); // 结束早于开始
    expect(isValidRange('2026-10-14', '08:15', '10:00', now)).toBe(false); // 非半小时刻度
    expect(isValidRange('2026-10-15', '07:00', '22:00', now)).toBe(true);
  });

  it('formatHourMinute 按北京时间显示（Dart 用的是设备时区）', () => {
    // 北京 2026-10-14 08:30
    expect(formatHourMinute(Date.UTC(2026, 9, 14, 0, 30))).toBe('08:30');
    expect(formatHourMinute(0)).toBe('');
  });

  it('楼层偏好规范化：2层 / 二楼 / 2 → 2楼', () => {
    expect(normalizeFloor('2层')).toBe('2楼');
    expect(normalizeFloor('二楼')).toBe('2楼');
    expect(normalizeFloor('2')).toBe('2楼');
    expect(normalizeFloor('4楼')).toBe('4楼');
    expect(normalizeFloor('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 8. 工具定义（名字必须与 ChillEast 完全一致）
// ---------------------------------------------------------------------------

describe('图书馆工具定义', () => {
  const tools = createLibraryTools();

  it('导出的工具名与 ChillEast 完全一致，共 8 个', () => {
    expect(tools.map((tool) => tool.name)).toEqual([...LIBRARY_TOOL_NAMES]);
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(8);
  });

  it('3 个别名与主名共用同一个 handler（同一份实现）', () => {
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get('quick_reserve')?.handler).toBe(
      byName.get('quick_reserve_library_seat')?.handler,
    );
    expect(byName.get('query_books')?.handler).toBe(byName.get('search_library_books')?.handler);
    expect(byName.get('query_book_detail')?.handler).toBe(
      byName.get('query_library_book_detail')?.handler,
    );
  });

  it('每个工具都有中文描述、object schema，且 additionalProperties=false', () => {
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.description).toMatch(/[\u4e00-\u9fa5]/);
      expect(tool.inputSchema['type']).toBe('object');
      expect(tool.inputSchema['additionalProperties']).toBe(false);
      expect(typeof tool.handler).toBe('function');
    }
  });

  it('检索工具的 keyword 必填、searchType 限定枚举、maxPages 有上限', () => {
    const search = tools.find((tool) => tool.name === 'search_library_books');
    expect(search?.inputSchema['required']).toEqual(['keyword']);
    const properties = search?.inputSchema['properties'] as Record<string, Record<string, unknown>>;
    expect(properties['searchType']['enum']).toEqual(['title', 'author', 'subject', 'Identifier']);
    expect(properties['maxPages']['maximum']).toBe(3);
    expect(properties['maxPages']['default']).toBe(1);
  });

  it('有副作用的工具必须在描述里写清楚「写操作 / 需要确认」', () => {
    const quick = tools.find((tool) => tool.name === 'quick_reserve_library_seat');
    expect(quick?.description).toContain('写操作');
    expect(quick?.description).toContain('confirmed=true');
    const reserve = tools.find((tool) => tool.name === 'reserve_library_seat');
    expect(reserve?.description).toContain('confirmed=true');
  });

  it('别名描述里说明了与主名等价', () => {
    expect(tools.find((tool) => tool.name === 'quick_reserve')?.description).toContain(
      'quick_reserve_library_seat',
    );
    expect(tools.find((tool) => tool.name === 'query_books')?.description).toContain(
      'search_library_books',
    );
    expect(tools.find((tool) => tool.name === 'query_book_detail')?.description).toContain(
      'query_library_book_detail',
    );
  });
});

// ---------------------------------------------------------------------------
// 9. CPU 预算：解析是这条链路上最重的本地计算
// ---------------------------------------------------------------------------

/** 造一页接近真实体积的检索结果（20 条书目 + 41 个分页选项）。 */
function bigSearchPage(): string {
  const item = (index: number) => `
      <li>
        <input type="hidden" disabled="disabled" name="detailParam" value='{"marc_no":"zyl00${index}"}'/>
        <input type="hidden" disabled="disabled" name="mainKey" value=''/>
        <input type="hidden" disabled="disabled" name="title" value='第${index}种水稻栽培技术手册'/>
        <input type="hidden" disabled="disabled" name="author" value='第${index}种水稻栽培技术手册'/>
        <input type="hidden" disabled="disabled" name="publisher" value='M'/>
        <input type="hidden" disabled="disabled" name="language" value=''/>
        <a href="javascript:void(0)" class="result">
          <div class="title"><span>第${index}种水稻栽培技术手册</span></div>
          <div class="detail">
            <p>作者：第${index}种水稻栽培技术手册</p>
            <p>索书号：空</p>
            <p>ISBN：S511-${index}/1</p>
            <p>出版社：M</p>
            <p>出版时间：978-7-109-3208${index}-0</p>
            <p>信息：${index} 第${index}种水稻栽培技术手册 某某某 编 空 M S511-${index}/1 北京:中国农业出版社 978-7-109-3208${index}-0 chi 2024</p>
          </div>
        </a>
      </li>`;
  const options = Array.from(
    { length: 41 },
    (_, i) => `<option value="/search/searchList?pageIndex=${i + 1}">${i + 1}/41</option>`,
  ).join('\n');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>检索列表</title></head><body>
  <div class="num"><h1>共806条搜索结果</h1></div>
  <div class="list"><ul>${Array.from({ length: 20 }, (_, i) => item(i + 1)).join('')}</ul></div>
  <select id="pagenum">${options}</select></body></html>`;
}

describe('CPU 预算（单次调用 10ms）', () => {
  it('检索列表页解析（约 40KB）远低于一次调用的 CPU 预算', async () => {
    const html = bigSearchPage();
    const iterations = 50;
    // 预热，避开首次 JIT
    for (let i = 0; i < 5; i++) await parseSearchPage(html);

    const started = performance.now();
    for (let i = 0; i < iterations; i++) await parseSearchPage(html);
    const total = performance.now() - started;
    const perPage = total / iterations;
    console.log(
      `  列表页解析（${html.length} 字节 × ${iterations} 次）  ${total.toFixed(1)} ms 总计` +
        `  （${perPage.toFixed(3)} ms/次，占 10ms 预算 ${((perPage / 10) * 100).toFixed(1)}%）`,
    );

    const parsed = await parseSearchPage(html);
    expect(parsed.items.length).toBe(20);
    expect(totalPagesFromTexts(parsed.pageTexts, 806)).toBe(41);
    // 一次调用最多解析 maxPages(=3) 页，这里留足余量
    expect(perPage * 3).toBeLessThan(10);
  }, 60_000);
});

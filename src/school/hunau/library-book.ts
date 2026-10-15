/**
 * 图书馆 OPAC 图书检索（`superlib.hunau.edu.cn`）客户端。
 *
 * 这条链路不需要鉴权，只靠超星 App 的 User-Agent + Referer。响应是 HTML，且字段
 * 顺序会因书目而异（服务端把列名接错了位），所以解析分两步：
 *   1. `parseSearchPage` / `parseBookDetailPage`：HTMLRewriter 单次遍历抽原始记录；
 *   2. `buildBooks` / `buildBookDetail`：纯函数装配 + 启发式纠偏（可单测）。
 *
 * CPU 预算 10ms/次：列表页一次遍历同时抽书目、总数、总页数；分页默认第 1 页，
 * 最多 3 页，并发不超过 3。
 */

import { CookieSession } from '../../auth/http';
import { CHAOXING_UA, HOSTS } from './constants';

const BASE_URL = HOSTS.superlib;
const SEARCH_PATH = '/search/searchList';
const DETAIL_PATH = '/search/bookDetail';

/** 湖南农大在超星 OPAC 里的学校 ID。 */
const SCHOOL_ID = '193';
/** 服务端固定每页 20 条（兜底估算总页数时用）。 */
const PAGE_SIZE = 20;
/** 默认只翻第 1 页。 */
export const DEFAULT_MAX_PAGES = 1;
/** 最多翻 3 页 —— Worker 里不能像 App 那样无限并发。 */
export const MAX_PAGE_LIMIT = 3;
/** 分页并发上限（Dart 是 5）。 */
const PAGE_CONCURRENCY = 3;

export const SEARCH_TYPES = ['title', 'author', 'subject', 'Identifier'] as const;

export class LibraryBookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LibraryBookError';
  }
}

export interface LibraryBook {
  detailParam: string;
  mainKey: string;
  title: string;
  author: string;
  callNumber: string;
  isbn: string;
  publisher: string;
  publishYear: string;
  /** 「信息：」汇总行原文（Case 1 才有） */
  rawInfo: string;
}

export interface LibraryBookHolding {
  barcode: string;
  volume: string;
  accessionNo: string;
  copyType: string;
  status: string;
  price: string;
  holdingUnit: string;
  location: string;
  notes: string;
}

export interface LibraryBookDetail {
  title: string;
  author: string;
  callNumber: string;
  subject: string;
  isbn: string;
  price: string;
  publishInfo: string;
  physicalDesc: string;
  series: string;
  summary: string;
  additionalInfo: string[];
  catalogItems: Array<{ label: string; value: string }>;
  holdings: LibraryBookHolding[];
}

export interface BookSearchResult {
  books: LibraryBook[];
  totalCount: number;
  totalPages: number;
}

// ---- 字段启发式（与客户端 _isXxx 一致） ----

/** 去掉空格与连字符后是 8 位以上纯数字（末位可为 X）—— 视为 ISBN。 */
export function isIsbn(value: string): boolean {
  const cleaned = value.replace(/[\s-]/g, '');
  return cleaned.length >= 8 && /^\d+([0-9Xx])?$/.test(cleaned);
}

/** 含 `/`，或形如 `S511.029.2-64/1` 的字母数字混排 —— 视为索书号。 */
export function isCallNumber(value: string): boolean {
  if (isIsbn(value)) return false;
  if (value.includes('/')) return true;
  return /^[A-Za-z0-9]+[.\-=][A-Za-z0-9]/.test(value);
}

export function isPublisher(value: string): boolean {
  for (const marker of ['出版社', '书局', '书店', '公司', '编辑部', '音像', '出版']) {
    if (value.includes(marker)) return true;
  }
  if ((value.includes(':') || value.includes('：')) && !value.startsWith('http')) return true;
  return false;
}

export function isDocType(value: string): boolean {
  return ['M', 'B', 'C', 'J', 'D', 'R', 'S', 'P'].includes(value.trim().toUpperCase());
}

const LANGUAGE_CODES = new Set([
  'chi',
  'eng',
  'chi eng',
  'eng chi',
  'fre',
  'ger',
  'jpn',
  'rus',
  'und',
]);

export function isLanguage(value: string): boolean {
  return LANGUAGE_CODES.has(value.trim().toLowerCase());
}

export function isYear(value: string): boolean {
  if (isIsbn(value)) return false;
  return /(19\d\d|20\d\d)(\.\d+)?/.test(value);
}

// ---- 原始记录 ----

export interface RawBookListItem {
  detailParam: string;
  mainKey: string;
  /** `input[name="title"]` 的值 */
  titleAttr: string;
  /** `.title span` 的文本（优先于 titleAttr） */
  titleText: string;
  authorAttr: string;
  publisherAttr: string;
  /** `.detail p` 的文本列表 */
  paragraphs: string[];
}

export interface RawHoldingRow {
  th: string;
  td: string;
}

export interface RawBookDetail {
  /** `header .tit h1` 文本 */
  titleText: string;
  /** `<title>` 文本（兜底） */
  docTitle: string;
  /** `.catalog p` 文本列表 */
  paragraphs: string[];
  /** 每个 `.tableLib .tableCon table` 一组 `(th, td)` 行 */
  tables: RawHoldingRow[][];
}

export interface RawSearchPage {
  items: RawBookListItem[];
  /** `.num h1` 文本（真实页面是「共806条搜索结果」） */
  countText: string;
  /** `.num` 文本（兜底） */
  numText: string;
  /** `#pagenum option` 文本（形如 `1/41`） */
  pageTexts: string[];
}

/** 用一次 HTMLRewriter 遍历解析检索列表页。 */
export async function parseSearchPage(html: string): Promise<RawSearchPage> {
  const items: RawBookListItem[] = [];
  const pageTexts: string[] = [];
  let current: RawBookListItem | null = null;
  let paragraphBuffer: string | null = null;
  let titleBuffer: string | null = null;
  let countText = '';
  let countBuffer: string | null = null;
  let numText = '';
  let numBuffer: string | null = null;
  let pageBuffer: string | null = null;

  await new HTMLRewriter()
    .on('.list ul li', {
      element() {
        current = {
          detailParam: '',
          mainKey: '',
          titleAttr: '',
          titleText: '',
          authorAttr: '',
          publisherAttr: '',
          paragraphs: [],
        };
        items.push(current);
      },
    })
    .on('.list ul li input', {
      element(element) {
        const item = current;
        if (item === null) return;
        const name = element.getAttribute('name') ?? '';
        const value = element.getAttribute('value') ?? '';
        if (name === 'detailParam') item.detailParam = value;
        else if (name === 'mainKey') item.mainKey = value;
        else if (name === 'title') item.titleAttr = value;
        else if (name === 'author') item.authorAttr = value;
        else if (name === 'publisher') item.publisherAttr = value;
      },
    })
    .on('.list ul li .title span', {
      element(element) {
        titleBuffer = '';
        element.onEndTag(() => {
          const item = current;
          if (item !== null) item.titleText = (titleBuffer ?? '').trim();
          titleBuffer = null;
        });
      },
      text(chunk) {
        if (titleBuffer !== null) titleBuffer += chunk.text;
      },
    })
    .on('.list ul li .detail p', {
      element(element) {
        paragraphBuffer = '';
        element.onEndTag(() => {
          const item = current;
          if (item !== null) item.paragraphs.push((paragraphBuffer ?? '').trim());
          paragraphBuffer = null;
        });
      },
      text(chunk) {
        if (paragraphBuffer !== null) paragraphBuffer += chunk.text;
      },
    })
    .on('.num h1', {
      element(element) {
        countBuffer = '';
        element.onEndTag(() => {
          countText = (countBuffer ?? '').trim();
          countBuffer = null;
        });
      },
      text(chunk) {
        if (countBuffer !== null) countBuffer += chunk.text;
      },
    })
    .on('.num', {
      element(element) {
        numBuffer = '';
        element.onEndTag(() => {
          numText = (numBuffer ?? '').trim();
          numBuffer = null;
        });
      },
      text(chunk) {
        if (numBuffer !== null) numBuffer += chunk.text;
      },
    })
    .on('#pagenum option', {
      element(element) {
        pageBuffer = '';
        element.onEndTag(() => {
          pageTexts.push((pageBuffer ?? '').trim());
          pageBuffer = null;
        });
      },
      text(chunk) {
        if (pageBuffer !== null) pageBuffer += chunk.text;
      },
    })
    .transform(new Response(html))
    .text();

  return { items, countText, numText, pageTexts };
}

/** 用一次 HTMLRewriter 遍历解析图书详情页（书目 + 馆藏表）。 */
export async function parseBookDetailPage(html: string): Promise<RawBookDetail> {
  const paragraphs: string[] = [];
  const tables: RawHoldingRow[][] = [];
  let titleText = '';
  let titleBuffer: string | null = null;
  let docTitle = '';
  let docTitleBuffer: string | null = null;
  let paragraphBuffer: string | null = null;
  let currentTable: RawHoldingRow[] | null = null;
  let currentRow: RawHoldingRow | null = null;
  let cellBuffer: string | null = null;

  await new HTMLRewriter()
    .on('header .tit h1', {
      element(element) {
        titleBuffer = '';
        element.onEndTag(() => {
          titleText = (titleBuffer ?? '').trim();
          titleBuffer = null;
        });
      },
      text(chunk) {
        if (titleBuffer !== null) titleBuffer += chunk.text;
      },
    })
    .on('title', {
      element(element) {
        docTitleBuffer = '';
        element.onEndTag(() => {
          docTitle = (docTitleBuffer ?? '').trim();
          docTitleBuffer = null;
        });
      },
      text(chunk) {
        if (docTitleBuffer !== null) docTitleBuffer += chunk.text;
      },
    })
    .on('.catalog p', {
      element(element) {
        paragraphBuffer = '';
        element.onEndTag(() => {
          paragraphs.push((paragraphBuffer ?? '').trim());
          paragraphBuffer = null;
        });
      },
      text(chunk) {
        if (paragraphBuffer !== null) paragraphBuffer += chunk.text;
      },
    })
    .on('.tableLib .tableCon table', {
      element() {
        currentTable = [];
        tables.push(currentTable);
      },
    })
    .on('.tableLib .tableCon table tr', {
      element() {
        const table = currentTable;
        if (table === null) return;
        currentRow = { th: '', td: '' };
        table.push(currentRow);
      },
    })
    .on('.tableLib .tableCon table th', {
      element(element) {
        cellBuffer = '';
        element.onEndTag(() => {
          const row = currentRow;
          // Dart 只取每行的第一个 th / td
          if (row !== null && row.th === '') row.th = (cellBuffer ?? '').trim();
          cellBuffer = null;
        });
      },
      text(chunk) {
        if (cellBuffer !== null) cellBuffer += chunk.text;
      },
    })
    .on('.tableLib .tableCon table td', {
      element(element) {
        cellBuffer = '';
        element.onEndTag(() => {
          const row = currentRow;
          if (row !== null && row.td === '') row.td = (cellBuffer ?? '').trim();
          cellBuffer = null;
        });
      },
      text(chunk) {
        if (cellBuffer !== null) cellBuffer += chunk.text;
      },
    })
    .transform(new Response(html))
    .text();

  return { titleText, docTitle, paragraphs, tables };
}

// ---- 纯装配逻辑 ----

/** 从 `.num h1`（优先）或 `.num` 里解析「共 N 条」。 */
export function totalCountFromTexts(countText: string, numText: string): number {
  const primary = /共\s*(\d+)\s*条/.exec(countText);
  if (primary !== null) return Number.parseInt(primary[1], 10);

  const secondary = /共\s*(\d+)\s*条/.exec(numText);
  if (secondary !== null) return Number.parseInt(secondary[1], 10);

  // 与 Dart 一致：整页文本兜底（这里只在两个候选里找，不做全量扫描）
  const fallback = /共\s*(\d+)\s*条搜索结果/.exec(`${countText} ${numText}`);
  return fallback === null ? 0 : Number.parseInt(fallback[1], 10);
}

/** 从 `#pagenum option` 的 `当前页/总页数` 解析总页数；没有就按每页 20 条估算。 */
export function totalPagesFromTexts(pageTexts: readonly string[], totalCount: number): number {
  for (const text of pageTexts) {
    const match = /\d+\s*\/\s*(\d+)/.exec(text);
    if (match !== null) {
      const pages = Number.parseInt(match[1], 10);
      if (pages > 0) return pages;
    }
  }
  if (totalCount > 0) return Math.ceil(totalCount / PAGE_SIZE);
  return 0;
}

/**
 * 列表页会用字面量「空」表示缺失值（实测：`<p>索书号：空</p>`）。
 * Dart 没有专门处理它 —— 按格式启发式恰好也不会把「空」误判成任何字段，
 * 但 Case 2 里 `作者：空` 会被原样当成作者名，所以这里统一归一成空串。
 */
function normalizeFieldValue(value: string): string {
  return value === '空' ? '' : value;
}

/** 文本里第一个中英文冒号的下标（找不到返回 -1）。 */
function firstColonIndex(text: string): number {
  const cn = text.indexOf('：');
  const en = text.indexOf(':');
  if (cn < 0) return en;
  if (en < 0) return cn;
  return Math.min(cn, en);
}

/**
 * 把一条原始记录装配成图书条目（含服务端字段错位的启发式纠偏）。
 * 返回 null 表示这条记录没有 detailParam，无法查询详情（与 Dart 的 `continue` 等价）。
 */
export function buildBookFromRaw(item: RawBookListItem): LibraryBook | null {
  const detailParam = item.detailParam.trim();
  if (detailParam === '') return null;

  const titleText = item.titleText.trim();
  const title = titleText !== '' ? titleText : item.titleAttr;

  const pMap = new Map<string, string>();
  const pValues: string[] = [];
  for (const raw of item.paragraphs) {
    const text = raw.trim();
    const index = firstColonIndex(text);
    if (index < 0) continue;
    const key = text.slice(0, index).trim();
    const value = normalizeFieldValue(text.slice(index + 1).trim());
    pMap.set(key, value);
    if (key !== '信息' && value !== '') pValues.push(value);
  }

  let author = '';
  let callNumber = '';
  let publisher = '';
  let isbn = '';
  let publishYear = '';
  let rawInfo = '';

  if (pMap.has('信息')) {
    // Case 1：页面带一行「信息：…」汇总，字段顺序固定，按位置 + 启发式取
    rawInfo = pMap.get('信息') ?? '';
    const tokens = rawInfo.split(/\s+/);
    for (const token of tokens) {
      if (isPublisher(token) && publisher === '') publisher = token;
      else if (isYear(token) && publishYear === '') publishYear = token;
      else if (isCallNumber(token) && callNumber === '') callNumber = token;
      else if (isIsbn(token) && isbn === '') isbn = token;
    }
    if (tokens.length >= 3) author = tokens[2];

    const isbnColumn = pMap.get('ISBN') ?? '';
    if (callNumber === '' && isCallNumber(isbnColumn)) callNumber = isbnColumn;
    const yearColumn = pMap.get('出版时间') ?? '';
    if (isbn === '' && isIsbn(yearColumn)) isbn = yearColumn;
  } else {
    // Case 2：列名整体错位（「作者」列里其实是题名/索书号），靠启发式挑
    const authorColumn = pMap.get('作者');
    if (
      authorColumn !== undefined &&
      !isCallNumber(authorColumn) &&
      !isIsbn(authorColumn) &&
      !isPublisher(authorColumn)
    ) {
      author = authorColumn;
    } else if (
      item.authorAttr !== '' &&
      !isCallNumber(item.authorAttr) &&
      !isIsbn(item.authorAttr) &&
      !isPublisher(item.authorAttr)
    ) {
      author = item.authorAttr;
    }

    const candidates = [...pValues];
    if (item.publisherAttr !== '') candidates.push(item.publisherAttr);

    for (const candidate of candidates) {
      if (candidate === '' || isDocType(candidate) || isLanguage(candidate)) continue;
      if (callNumber === '' && isCallNumber(candidate)) callNumber = candidate;
      else if (publisher === '' && isPublisher(candidate)) publisher = candidate;
      else if (isbn === '' && isIsbn(candidate)) isbn = candidate;
      else if (publishYear === '' && isYear(candidate)) publishYear = candidate;
    }
  }

  return {
    detailParam,
    mainKey: item.mainKey,
    title,
    author,
    callNumber,
    isbn,
    publisher,
    publishYear,
    rawInfo,
  };
}

export function buildBooks(items: readonly RawBookListItem[]): LibraryBook[] {
  const books: LibraryBook[] = [];
  for (const item of items) {
    const book = buildBookFromRaw(item);
    if (book !== null) books.push(book);
  }
  return books;
}

/** 单册馆藏：一行一个字段，取不到有效信息返回 null。 */
export function buildHolding(rows: readonly RawHoldingRow[]): LibraryBookHolding | null {
  let barcode = '';
  let volume = '';
  let accessionNo = '';
  let copyType = '';
  let status = '';
  let unitPrice = '';
  let holdingUnit = '';
  let location = '';
  let notes = '';

  for (const row of rows) {
    switch (row.th) {
      case '条码号':
        barcode = row.td;
        break;
      case '卷册号':
        volume = row.td;
        break;
      case '登录号':
        accessionNo = row.td;
        break;
      case '单册类型':
        copyType = row.td;
        break;
      case '状态':
        status = row.td;
        break;
      case '单价':
        unitPrice = row.td;
        break;
      case '馆藏单位':
        holdingUnit = row.td;
        break;
      case '典藏地':
        location = row.td;
        break;
      case '拒借':
      case '备注':
        notes = row.td;
        break;
      default:
        break;
    }
  }

  // 页面底部有一张「占位模板表」，它的单元格值直接就是字段名
  if (barcode === '馆藏单位' || copyType === '到书时间' || location === '预约时间') return null;
  if (barcode === '' && location === '' && status === '') return null;

  return {
    barcode,
    volume,
    accessionNo,
    copyType,
    status,
    price: unitPrice,
    holdingUnit,
    location,
    notes,
  };
}

export function holdingIsAvailable(holding: LibraryBookHolding): boolean {
  return holding.status.includes('在库') || holding.status.includes('可借');
}

/** 目录项为空时，用已解析出的字段拼出一份（与 Dart `effectiveCatalogItems` 一致）。 */
export function effectiveCatalogItems(detail: LibraryBookDetail): Array<{
  label: string;
  value: string;
}> {
  if (detail.catalogItems.length > 0) return detail.catalogItems;
  const items: Array<{ label: string; value: string }> = [];
  const join = (parts: string[]) => parts.filter((part) => part !== '').join(' / ');
  if (detail.author !== '' || detail.title !== '') {
    items.push({ label: '题名/责任者', value: join([detail.title, detail.author]) });
  }
  if (detail.isbn !== '' || detail.price !== '') {
    items.push({ label: 'ISBN号/定价', value: join([detail.isbn, detail.price]) });
  }
  if (detail.publishInfo !== '') items.push({ label: '出版项', value: detail.publishInfo });
  if (detail.subject !== '' || detail.callNumber !== '') {
    items.push({ label: '主题词/索书号', value: join([detail.subject, detail.callNumber]) });
  }
  if (detail.physicalDesc !== '') items.push({ label: '载体形态', value: detail.physicalDesc });
  if (detail.series !== '') items.push({ label: '丛编项', value: detail.series });
  if (detail.summary !== '') items.push({ label: '文摘题要', value: detail.summary });
  return items;
}

export interface BookDetailDefaults {
  title?: string;
  author?: string;
  callNumber?: string;
  isbn?: string;
  publisher?: string;
}

/**
 * 装配图书详情：目录项 + 馆藏副本表。
 * 与 Dart `parseBookDetailFromDocument` 一一对应。
 */
export function buildBookDetail(
  raw: RawBookDetail,
  defaults: BookDetailDefaults = {},
): LibraryBookDetail {
  let title = raw.titleText !== '' ? raw.titleText : raw.docTitle;
  if (title === '') title = defaults.title ?? '';

  if (title.includes(' / ')) title = title.split(' / ')[0].trim();

  let author = defaults.author ?? '';
  let callNumber = defaults.callNumber ?? '';
  let subject = '';
  let isbn = defaults.isbn ?? '';
  let price = '';
  let publishInfo = defaults.publisher ?? '';
  let physicalDesc = '';
  let series = '';
  let summary = '';
  const additionalInfo: string[] = [];
  const catalogItems: Array<{ label: string; value: string }> = [];

  for (const rawText of raw.paragraphs) {
    const text = rawText.trim();
    if (text === '') continue;
    const colonIndex = firstColonIndex(text);
    const key = colonIndex >= 0 ? text.slice(0, colonIndex).trim() : '';
    const value = colonIndex >= 0 ? text.slice(colonIndex + 1).trim() : text;

    if (key !== '' && value !== '') catalogItems.push({ label: key, value });

    if (key.includes('题名/责任者') || key === '题名') {
      if (value.includes(' / ')) {
        const parts = value.split(' / ');
        if (title === '') title = parts[0].trim();
        author = parts[1].trim();
      } else if (value.includes('/')) {
        const parts = value.split('/');
        if (title === '') title = parts[0].trim();
        author = parts[1].trim();
      } else if (author === '') {
        author = value;
      }
    } else if (key.includes('主题词/索书号') || key.includes('索书号')) {
      if (value.includes(' / ')) {
        const parts = value.split(' / ');
        subject = parts[0].trim();
        callNumber = parts[1].trim();
      } else if (value.startsWith('/')) {
        callNumber = value.replace(/^\s*\/\s*/, '').trim();
      } else {
        callNumber = value;
      }
    } else if (key.includes('ISBN号/定价') || key.includes('ISBN')) {
      if (value.includes(' / ')) {
        const parts = value.split(' / ');
        isbn = parts[0].trim();
        price = parts[1].trim();
      } else {
        isbn = value;
      }
      if (isbn === '7-' || isbn === '/' || isbn === '-') isbn = '';
      if (price === '0元' || price === '0.00元' || price === '/') price = '';
    } else if (key.includes('出版项')) {
      publishInfo = value;
    } else if (key.includes('载体形态') || key.includes('形态')) {
      physicalDesc = value;
    } else if (key.includes('丛编项') || key.includes('丛书')) {
      series = value;
    } else if (key.includes('文摘题要') || key.includes('简介') || key.includes('摘要')) {
      summary = value;
    } else if (text !== '') {
      additionalInfo.push(text);
    }
  }

  const holdings: LibraryBookHolding[] = [];
  for (const rows of raw.tables) {
    const holding = buildHolding(rows);
    if (holding !== null) holdings.push(holding);
  }

  return {
    title,
    author,
    callNumber,
    subject,
    isbn,
    price,
    publishInfo,
    physicalDesc,
    series,
    summary,
    additionalInfo,
    catalogItems,
    holdings,
  };
}

// ---- HTTP ----

function opacSession(): CookieSession {
  return new CookieSession(undefined, CHAOXING_UA);
}

function opacHeaders(): Record<string, string> {
  return {
    Referer: `${BASE_URL}/`,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,' +
      'image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };
}

function searchPageUrl(keyword: string, searchType: string, pageIndex: number): string {
  const query = new URLSearchParams();
  query.set('kw', keyword);
  if (pageIndex <= 1) {
    // 第 1 页的参数与新版本入口保持一致（与 ChillEast 客户端相同）
    query.set('xc', '3');
    query.set('schoolid', SCHOOL_ID);
    query.set('searchtype', searchType);
  } else {
    // 第 2 页起与 ChillEast 客户端一致（也等于站点分页下拉框里那条链接的参数）。
    //
    // ⚠️ 实测（2026-10）：这个 URL 服务端会返回「共0条搜索结果」的空页，
    // 换 `page=` 则被忽略、原样返回第 1 页；`pageSize` / `rows` 也无效。
    // 也就是说**该移动端 OPAC 目前翻不了页**，ChillEast 同样是这个行为
    // （它的 `_fetchPage` 把解析不到条目的页当成空数组吞掉了）。
    // 这里保持与 ChillEast 客户端完全一致，翻页失败只会少拿到结果，不会报错。
    query.set('schoolid', SCHOOL_ID);
    query.set('pageIndex', String(pageIndex));
    query.set('searchtype', searchType);
    query.set('doctype', '');
    query.set('xc', '3');
    query.set('pagingParam', '{}');
  }
  return `${BASE_URL}${SEARCH_PATH}?${query.toString()}`;
}

async function fetchSearchPage(
  session: CookieSession,
  keyword: string,
  searchType: string,
  pageIndex: number,
): Promise<RawSearchPage> {
  const response = await session.get(searchPageUrl(keyword, searchType, pageIndex), {
    headers: opacHeaders(),
  });
  if (response.status !== 200) {
    throw new LibraryBookError(`检索请求失败: HTTP ${response.status}`);
  }
  return await parseSearchPage(response.body);
}

/** 页面结构完全对不上（被拦截 / 接口改版）—— 直接报错，别静默返回空结果。 */
function looksLikeSearchPage(page: RawSearchPage): boolean {
  return (
    page.items.length > 0 ||
    page.countText !== '' ||
    page.numText !== '' ||
    page.pageTexts.length > 0
  );
}

export interface SearchBooksOptions {
  keyword: string;
  searchType?: string;
  /** 最多翻几页（1-3），默认 1 */
  maxPages?: number;
}

/**
 * 检索图书。默认只取第 1 页；`maxPages` 可放宽到 3 页，页间并发不超过 3。
 */
export async function searchLibraryBooks(options: SearchBooksOptions): Promise<BookSearchResult> {
  const keyword = options.keyword.trim();
  if (keyword === '') return { books: [], totalCount: 0, totalPages: 0 };

  const searchType = (options.searchType ?? 'title').trim() || 'title';
  const session = opacSession();

  const firstPage = await fetchSearchPage(session, keyword, searchType, 1);
  if (!looksLikeSearchPage(firstPage)) {
    throw new LibraryBookError('检索页结构无法识别（可能被网关拦截或接口已改版）');
  }

  const totalCount = totalCountFromTexts(firstPage.countText, firstPage.numText);
  const totalPages = totalPagesFromTexts(firstPage.pageTexts, totalCount);
  const books = buildBooks(firstPage.items);

  const requestedPages = Math.trunc(options.maxPages ?? DEFAULT_MAX_PAGES);
  const maxPages = Math.min(Math.max(requestedPages, 1), MAX_PAGE_LIMIT);
  const lastPage = Math.min(totalPages > 0 ? totalPages : 1, maxPages);

  if (lastPage <= 1) {
    return {
      books,
      totalCount: totalCount > 0 ? totalCount : books.length,
      totalPages: totalPages > 0 ? totalPages : 1,
    };
  }

  const remaining: number[] = [];
  for (let page = 2; page <= lastPage; page++) remaining.push(page);

  for (let i = 0; i < remaining.length; i += PAGE_CONCURRENCY) {
    const batch = remaining.slice(i, i + PAGE_CONCURRENCY);
    const pages = await Promise.all(
      batch.map(async (pageIndex) => {
        try {
          const page = await fetchSearchPage(session, keyword, searchType, pageIndex);
          return buildBooks(page.items);
        } catch {
          // 单页失败不影响整体（与 Dart 的 _fetchPage 一致）
          return [] as LibraryBook[];
        }
      }),
    );
    for (const pageBooks of pages) books.push(...pageBooks);
  }

  return {
    books,
    totalCount: totalCount > 0 ? totalCount : books.length,
    totalPages: totalPages > 0 ? totalPages : 1,
  };
}

/** 查询图书详情（书目 + 馆藏副本），同样无需鉴权。 */
export async function fetchLibraryBookDetail(book: {
  detailParam: string;
  mainKey?: string;
  title?: string;
  author?: string;
  publisher?: string;
}): Promise<LibraryBookDetail> {
  const session = opacSession();
  const response = await session.postForm(
    `${BASE_URL}${DETAIL_PATH}`,
    [
      ['detailParam', book.detailParam],
      ['mainKey', book.mainKey ?? ''],
      ['title', book.title ?? ''],
      ['author', book.author ?? ''],
      ['publisher', book.publisher ?? ''],
      ['language', ''],
      ['xc', '3'],
      ['schoolid', SCHOOL_ID],
    ],
    { headers: opacHeaders() },
  );
  if (response.status !== 200) {
    throw new LibraryBookError(`获取图书详情失败: HTTP ${response.status}`);
  }

  const raw = await parseBookDetailPage(response.body);
  return buildBookDetail(raw, {
    title: book.title,
    author: book.author,
    publisher: book.publisher,
  });
}

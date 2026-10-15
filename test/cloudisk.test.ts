import { describe, expect, it } from 'vitest';
import {
  buildBackupFileName,
  parseBackupFileName,
  parseSession,
  pickLatestBackupEntry,
  pickStaleEntries,
  pickTargetSlot,
  type CloudiskEntry,
} from '../src/school/hunau/cloudisk';
import {
  withManualHomework,
  withTimetableRules,
  readManualHomework,
  readTimetableRules,
  type BackupDocument,
} from '../src/school/hunau/backup';

function entry(name: string, id: string, encryptedId = 'enc'): CloudiskEntry {
  return { raw: {}, name, id, encryptedId, puid: 'p1' };
}

describe('云盘首页会话解析', () => {
  /** 首页模板里塞了不少以 `_token` 结尾的干扰串，这是 Dart 注释特别强调的坑。 */
  const html = `
    <script>
      var p_auth_token = "";
      var cx_p_token = "should-not-win";
      const encstr = "ENC123";
      var rootdir = "ROOT456";
      const currentPuid = "PUID789";
    </script>
    <a href="/x?p_auth_token=">link</a>
    <script>
      const _token = "REALTOKEN";
    </script>
  `;

  it('四个常量都能取到，且不会被 p_auth_token / cx_p_token 干扰', () => {
    const session = parseSession(html);
    expect(session.enc).toBe('ENC123');
    expect(session.rootDirId).toBe('ROOT456');
    expect(session.puid).toBe('PUID789');
    // 关键：必须是真正的 _token，不是 p_auth_token / cx_p_token
    expect(session.token).toBe('REALTOKEN');
  });

  it('取最后一个非空命中（真正的 _token 在文末）', () => {
    const twoTokens = `const _token = ""; ... const _token = "SECOND";`;
    expect(parseSession(`${twoTokens} const encstr="e"; var rootdir="r"; const currentPuid="p";`).token).toBe(
      'SECOND',
    );
  });

  it('多个 _token 候选时优先取 32 位 hex（实测踩到的坑）', () => {
    // 实测：服务端回了「错误的_token值」，因为「取最后一个非空」拿到的是 12 位值。
    // Dart 注释明确说真正的 _token 是 32 位 hex，所以按格式优先挑。
    const real = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'; // 32 hex
    const page = `
      const _token = "abcdef123456";
      const encstr="E"; var rootdir="R"; const currentPuid="P";
      <a href="/x?_token=zzz">link</a>
      const _token = "${real}";
      const _token = "short12chars";
    `;
    expect(parseSession(page).token).toBe(real);
  });

  it('没有 32 位 hex 候选时退回最后一个非空（不阻断）', () => {
    const page = `const _token = "abc"; const _token = "def"; const encstr="E"; var rootdir="R"; const currentPuid="P";`;
    expect(parseSession(page).token).toBe('def');
  });

  it('缺任意一个常量都视为会话失效', () => {
    const missingToken = `const encstr="e"; var rootdir="r"; const currentPuid="p";`;
    expect(() => parseSession(missingToken)).toThrow(/会话失效/);
    expect(() => parseSession('')).toThrow(/会话失效/);
  });
});

describe('备份文件名', () => {
  it('解析合法文件名', () => {
    expect(parseBackupFileName('chilleast-backup-a-20261014-093000.json')).toEqual({
      slot: 'a',
      stamp: '20261014-093000',
    });
    expect(parseBackupFileName('chilleast-backup-b-20260101-000000.json')).toEqual({
      slot: 'b',
      stamp: '20260101-000000',
    });
  });

  it('拒绝不合规的名字', () => {
    expect(parseBackupFileName('chilleast-backup-c-20261014-093000.json')).toBeNull();
    expect(parseBackupFileName('chilleast-backup-a-20261014.json')).toBeNull();
    expect(parseBackupFileName('随便一个文件.txt')).toBeNull();
    expect(parseBackupFileName('chilleast-backup-a-20261014-093000.json.bak')).toBeNull();
    expect(parseBackupFileName('')).toBeNull();
  });

  it('stamp 用**北京时间**，不是 UTC（实测踩到的坑）', () => {
    // Worker 跑在 UTC，App 跑在手机本地时区（国内 UTC+8）。
    // 如果这里用 getUTCHours，生成的文件名会比 App 的早 8 小时，
    // 而「按文件名字典序取最新」正是 A/B 轮换的核心假设 —— 会被判成更旧。
    // 实测：App 写 124600（12:46），我写 044754（04:47），同一时刻却差 8 小时。
    const noonBeijing = new Date(Date.UTC(2026, 9, 14, 4, 47, 54)); // 北京时间 12:47:54
    expect(parseBackupFileName(buildBackupFileName('a', noonBeijing))).toEqual({
      slot: 'a',
      stamp: '20261014-124754',
    });

    // 跨日边界：UTC 还是 10-13，北京已经是 10-14
    const justAfterMidnightBeijing = new Date(Date.UTC(2026, 9, 13, 16, 0, 0));
    expect(parseBackupFileName(buildBackupFileName('b', justAfterMidnightBeijing))).toEqual({
      slot: 'b',
      stamp: '20261014-000000',
    });
  });

  it('生成的名字能被解析回来，且 stamp 按字典序即时间序', () => {
    const early = buildBackupFileName('a', new Date(Date.UTC(2026, 0, 1, 8, 0, 0)));
    const late = buildBackupFileName('b', new Date(Date.UTC(2026, 9, 14, 9, 30, 0)));
    expect(parseBackupFileName(early)).toEqual({ slot: 'a', stamp: '20260101-160000' });
    expect(parseBackupFileName(late)).toEqual({ slot: 'b', stamp: '20261014-173000' });
    expect(late > early).toBe(true);
  });

  it('按 stamp 比较才正确 —— 整个文件名比较会先比槽位字母', () => {
    // App 在 12:46:00（北京）写的（槽位 b）
    const appEntry = entry('chilleast-backup-b-20261014-124600.json', 'r-app');
    // Worker 在 12:47:54（北京）写的（槽位 a，晚 1 分 54 秒）
    const workerEntry = entry(
      buildBackupFileName('a', new Date(Date.UTC(2026, 9, 14, 4, 47, 54))),
      'r-worker',
    );

    // 整个字符串比较：'-a-' < '-b-'，会误判成 App 那份更新（错的）
    expect(workerEntry.name > appEntry.name).toBe(false);
    // 按 stamp 比较才是对的：Worker 那份更新
    expect(pickLatestBackupEntry([appEntry, workerEntry])?.id).toBe('r-worker');
    expect(pickLatestBackupEntry([workerEntry, appEntry])?.id).toBe('r-worker');
  });

  it('A/B 槽位轮换', () => {
    expect(pickTargetSlot(null)).toBe('a');
    expect(pickTargetSlot('a')).toBe('b');
    expect(pickTargetSlot('b')).toBe('a');
  });
});

describe('App 的比较规则决定了 Worker 必须固定写 b 槽', () => {
  it('两份文件时 -b- 恒胜，哪怕 -a- 更新（App 的行为）', () => {
    const newerA = entry('chilleast-backup-a-20261014-150000.json', 'r-a');
    const olderB = entry('chilleast-backup-b-20261014-090000.json', 'r-b');
    // 按 stamp 比：a 更新
    expect(parseBackupFileName(newerA.name)?.stamp).toBe('20261014-150000');
    // 但 App 比的是整个文件名，'-b-' > '-a-'，于是拉到旧的那份
    expect(olderB.name > newerA.name).toBe(true);
  });

  it('Worker 固定写 b：对 -a- 恒胜，对另一个 -b- 则比 stamp 且新的胜', () => {
    // 对 App 写的 -a-
    const appA = entry('chilleast-backup-a-20261014-150000.json', 'r-app');
    const workerB = entry('chilleast-backup-b-20261014-150100.json', 'r-worker');
    expect(workerB.name > appA.name).toBe(true);
    expect(pickLatestBackupEntry([appA, workerB])?.id).toBe('r-worker');

    // 对 App 写的 -b-（同槽位 → 比 stamp）
    const appBOlder = entry('chilleast-backup-b-20261014-140000.json', 'r-old');
    expect(pickLatestBackupEntry([appBOlder, workerB])?.id).toBe('r-worker');
  });

  it('清理失败、两份都在时，App 依然会选中 Worker 的 b 槽（不依赖清理成功）', () => {
    const appA = entry('chilleast-backup-a-20261014-160000.json', 'r-app-newer');
    const workerB = entry('chilleast-backup-b-20261014-150100.json', 'r-worker');

    // ⚠️ 这里必须分别模拟两套比较逻辑，不能混用：
    //   - App 的 pickLatestBackupEntry 比**整个文件名**（cloud_backup_manager.dart:83）
    //   - 我们自己的 pickLatestBackupEntry 已经改成比 **stamp**（更正确）
    const appPick = (list: CloudiskEntry[]): CloudiskEntry | null => {
      let best: CloudiskEntry | null = null;
      for (const item of list) {
        if (parseBackupFileName(item.name) === null) continue;
        if (best === null || item.name > best.name) best = item;
      }
      return best;
    };

    // App 会选 b 槽（哪怕 a 那份的 stamp 更新）→ Worker 固定写 b 才不会被忽略
    expect(appPick([appA, workerB])?.id).toBe('r-worker');
    expect(appPick([workerB, appA])?.id).toBe('r-worker');

    // 而我们自己的函数按 stamp，会选出真正最新的那份 —— 两者行为不同是有意的
    expect(pickLatestBackupEntry([appA, workerB])?.id).toBe('r-app-newer');
  });
});

describe('挑选最新备份与待清理项', () => {
  const entries = [
    entry('chilleast-backup-a-20261001-120000.json', 'r1'),
    entry('chilleast-backup-b-20261014-093000.json', 'r2'),
    entry('chilleast-backup-a-20261010-120000.json', 'r3'),
    entry('无关文件.txt', 'r4'),
  ];

  it('取文件名最大的那个（stamp 字典序即时间序）', () => {
    expect(pickLatestBackupEntry(entries)?.id).toBe('r2');
  });

  it('忽略非备份文件；没有备份时返回 null', () => {
    expect(pickLatestBackupEntry([entry('无关.txt', 'x')])).toBeNull();
    expect(pickLatestBackupEntry([])).toBeNull();
  });

  it('缺 id 或 encryptedId 的条目不算数（没它们无法下载/删除）', () => {
    expect(pickLatestBackupEntry([entry('chilleast-backup-a-20261001-120000.json', '', '')])).toBeNull();
  });

  it('待清理项排除刚上传的那个', () => {
    const stale = pickStaleEntries(entries, 'r2');
    expect(stale.map((item) => item.id).sort()).toEqual(['r1', 'r3']);
  });
});

describe('备份文档的字段保全（最重要的一条约束）', () => {
  const backup: BackupDocument = {
    format: 'chilleast-backup',
    version: 1,
    appVersion: '1.0.11+12',
    settings: { languageCode: 'zh', courseReminderMinutes: 15, ai: { model: 'x' } },
    localData: {
      timetableIcs: 'BEGIN:VCALENDAR',
      courses: { a: 1 },
      timetableRules: [{ id: 'old' }],
      homeworkList: [{ id: 'h1', title: 'A', isManual: true }],
    },
  };

  it('写规则时不动 settings 与其它 localData 字段', () => {
    const next = withTimetableRules(backup, [{ id: 'new' }]);
    expect(next.settings).toEqual(backup.settings);
    expect(next.localData?.['timetableIcs']).toBe('BEGIN:VCALENDAR');
    expect(next.localData?.['courses']).toEqual({ a: 1 });
    expect(next.localData?.['homeworkList']).toEqual(backup.localData?.['homeworkList']);
    expect(next.localData?.['timetableRules']).toEqual([{ id: 'new' }]);
    // 原对象不能被改（避免调用方拿到半更新状态）
    expect(backup.localData?.['timetableRules']).toEqual([{ id: 'old' }]);
  });

  it('写作业时不动 settings 与规则', () => {
    const next = withManualHomework(backup, [{ id: 'h2', title: 'B', isManual: true }]);
    expect(next.settings).toEqual(backup.settings);
    expect(next.localData?.['timetableRules']).toEqual([{ id: 'old' }]);
    expect(next.localData?.['homeworkList']).toEqual([{ id: 'h2', title: 'B', isManual: true }]);
  });

  it('读时过滤掉 isManual != true 的项（爬取的作业不进备份）', () => {
    const mixed = withManualHomework(backup, [
      { id: 'm1', isManual: true },
      { id: 's1', isManual: false },
    ]);
    expect(readManualHomework(mixed).map((item) => item['id'])).toEqual(['m1']);
  });

  it('字段缺失时读成空数组而不是抛错', () => {
    expect(readTimetableRules({})).toEqual([]);
    expect(readTimetableRules({ localData: { timetableRules: 'not-an-array' } })).toEqual([]);
    expect(readManualHomework({})).toEqual([]);
  });
});

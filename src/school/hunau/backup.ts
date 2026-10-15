/**
 * ChillEast 备份文档的读写。
 *
 * 备份 JSON 的结构照抄 `backup_export_service.dart` 的 `buildBackupData`：
 *
 *   { format, version, exportedAt, appVersion, settings: {...}, localData: {...} }
 *
 * **写回时必须完整保留 `settings` 与其它 `localData` 字段** —— 只改我们关心的那一个。
 * 否则用户手机上的设置会被 Worker 覆盖掉。这是这个模块最重要的一条约束。
 */

import type { CookieSession } from '../../auth/http';
import {
  buildBackupFileName,
  deleteFile,
  downloadFile,
  listBackupEntries,
  pickLatestBackupEntry,
  parseBackupFileName,
  pickStaleEntries,
  uploadFile,
  type CloudiskEntry,
  type CloudiskSession,
} from './cloudisk';

export const BACKUP_FORMAT = 'chilleast-backup';
export const BACKUP_VERSION = 1;

export interface BackupDocument {
  format?: string;
  version?: number;
  exportedAt?: string;
  appVersion?: string;
  settings?: Record<string, unknown>;
  localData?: Record<string, unknown>;
  [key: string]: unknown;
}

export class BackupNotFoundError extends Error {
  constructor(listedNames: readonly string[] = []) {
    const detail =
      listedNames.length === 0
        ? '云盘根目录里当前没有任何文件。'
        : `云盘根目录里有 ${listedNames.length} 个文件，但没有一个匹配 `
          + `chilleast-backup-*.json：${listedNames.slice(0, 10).join('、')}`;
    super(
      '云端没有找到 ChillEast 备份。请先在手机 App 里打开「设置 → 数据 → 数据同步」' +
        `并等待一次同步完成。\n${detail}`,
    );
    this.name = 'BackupNotFoundError';
  }
}

export interface LoadedBackup {
  backup: BackupDocument;
  entry: CloudiskEntry;
  slot: string;
}

/** 读云端最新的备份。没有备份时抛 BackupNotFoundError（带可操作的提示）。 */
export async function readLatestBackup(
  session: CookieSession,
  auth: CloudiskSession,
): Promise<LoadedBackup> {
  const entries = await listBackupEntries(session, auth, auth.rootDirId);
  const entry = pickLatestBackupEntry(entries);
  if (entry === null) {
    // 把实际看到的文件名带出来 —— 否则只能猜是"没开同步"还是"文件名不匹配"
    console.warn(
      JSON.stringify({ event: 'backup_not_found', listedNames: entries.map((item) => item.name) }),
    );
    throw new BackupNotFoundError(entries.map((item) => item.name));
  }

  const bytes = await downloadFile(session, auth, {
    resid: entry.id,
    encryptedId: entry.encryptedId,
    puid: entry.puid,
    folderId: auth.rootDirId,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`云端备份 ${entry.name} 不是合法 JSON，已中止（不会覆盖它）`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`云端备份 ${entry.name} 结构异常，已中止`);
  }
  const backup = parsed as BackupDocument;
  if (backup.format !== BACKUP_FORMAT) {
    throw new Error(
      `云端文件 ${entry.name} 的 format 是 ${String(backup.format)}，不是 ${BACKUP_FORMAT}`,
    );
  }

  console.log(
    JSON.stringify({
      event: 'backup_read',
      file: entry.name,
      bytes: bytes.length,
      // 只记结构，不记内容（里面有用户设置）
      localDataKeys: Object.keys(backup.localData ?? {}),
    }),
  );

  return { backup, entry, slot: entry.name.includes('-a-') ? 'a' : 'b' };
}

/**
 * 写回备份：**固定写 `b` 槽，不跟 App 做 A/B 轮换。**
 * A/B 轮换的本意是崩溃安全（上传到新名字，成功后再删旧的；上传失败旧副本还在），这一点
 * 固定槽位同样满足 —— 我上传的是 `b-<新时间戳>`，与旧文件不同名。但 App 的「取最新」比的是
 * **整个文件名**（`cloud_backup_manager.dart:83`），而文件名是 `…-{slot}-{stamp}.json`，于是
 * `-a-` 永远排在 `-b-` 前面，与时间无关：若云端最新是 `-b-` 而我按轮换写 `-a-`，App 拉取时
 * **永远选它自己那份旧的**，我的改动进不了手机（只要旧文件还在，比如我的清理没成功）；反过来
 * 固定写 `b`，对 `-a-` 恒胜，对另一个 `-b-` 则退回比 stamp、新的胜 —— 无论清理是否成功，
 * 我的写入都能被 App 正确地选中。等 App 把比较改成按 stamp（:83 与 :337）再恢复 A/B 不迟。
 */
export async function writeBackup(
  session: CookieSession,
  auth: CloudiskSession,
  backup: BackupDocument,
  previousSlot: string | null,
): Promise<{ filename: string; resid: string }> {
  // previousSlot 保留在签名里（便于将来恢复 A/B），但当前固定用 b
  void previousSlot;
  const target: 'a' | 'b' = 'b';
  const filename = buildBackupFileName(target, new Date());

  const document: BackupDocument = {
    ...backup, // 保留 format / version / settings / 其它 localData 字段
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(document));

  const uploaded = await uploadFile(session, auth, auth.rootDirId, filename, bytes);

  // 收敛清理：删掉其它备份，只留刚上传的这份。
  //
  // ⚠️ 清理是**破坏性**操作，必须先确认刚上传的文件已经出现在列表里。
  // 如果列表里看不到它（索引延迟 / 服务端改了 id），就千万别删 ——
  // 否则可能把旧文件删了、新文件又不算数，结果一份备份都不剩。
  // 这正是实测踩到的坑：上传成功后反而报「云端没有找到备份」。
  try {
    const entries = await listBackupEntries(session, auth, auth.rootDirId);
    const newFileVisible = entries.some(
      (item) => item.id === uploaded.resid || item.name === filename,
    );
    if (!newFileVisible) {
      console.warn(
        JSON.stringify({
          event: 'backup_prune_skipped_new_file_missing',
          uploadedResid: uploaded.resid,
          filename,
          listedNames: entries.map((item) => item.name),
        }),
      );
      return { filename, resid: uploaded.resid };
    }
    // 只删**严格更旧**的备份。
    // App 的策略是"删掉所有其它同前缀文件"，但 Worker 不能这么干 ——
    // 万一另一个写入方（比如 App 正在同步）刚写了更新的备份，那样会把它删掉，
    // 双方互相删除，最后一份备份都不剩（实测踩到过）。
    const others = pickStaleEntries(entries, uploaded.resid);
    // 按 stamp 比较，不能按整个文件名（`-a-` 会永远排在 `-b-` 前面）
    const uploadedStamp = parseBackupFileName(filename)?.stamp ?? '';
    const older = others.filter((item) => {
      const stamp = parseBackupFileName(item.name)?.stamp ?? '';
      return stamp < uploadedStamp;
    });
    if (older.length < others.length) {
      console.warn(
        JSON.stringify({
          event: 'backup_prune_kept_newer',
          kept: others
            .filter((item) => (parseBackupFileName(item.name)?.stamp ?? '') >= uploadedStamp)
            .map((item) => item.name),
        }),
      );
    }

    for (const stale of older) {
      try {
        await deleteFile(session, auth, {
          resid: stale.id,
          encryptedId: stale.encryptedId,
          puid: stale.puid,
        });
      } catch (error) {
        // 单个删除失败不影响整体
        console.warn(
          JSON.stringify({
            event: 'backup_prune_failed',
            name: stale.name,
            message: error instanceof Error ? error.message : 'unknown',
          }),
        );
      }
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'backup_prune_skipped',
        message: error instanceof Error ? error.message : 'unknown',
      }),
    );
  }

  console.log(JSON.stringify({ event: 'backup_written', file: filename, bytes: bytes.length }));
  return { filename, resid: uploaded.resid };
}

// ---- localData 里的两个字段 -------------------------------------------------

/** 读出 `localData.timetableRules`（不是数组就返回空）。 */
export function readTimetableRules(backup: BackupDocument): unknown[] {
  const rules = backup.localData?.['timetableRules'];
  return Array.isArray(rules) ? rules : [];
}

/** 写入 `localData.timetableRules`，其余字段原样保留。 */
export function withTimetableRules(
  backup: BackupDocument,
  rules: readonly unknown[],
): BackupDocument {
  return { ...backup, localData: { ...(backup.localData ?? {}), timetableRules: [...rules] } };
}

/** 读出 `localData.homeworkList`（只含 isManual 的项）。 */
export function readManualHomework(backup: BackupDocument): Array<Record<string, unknown>> {
  const list = backup.localData?.['homeworkList'];
  if (!Array.isArray(list)) return [];
  return list.filter(
    (item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null && (item as Record<string, unknown>)['isManual'] === true,
  );
}

/**
 * 写入 `localData.homeworkList`，其余字段原样保留。
 * 泛型是为了让调用方可以传自己的结构化类型（接口没有索引签名，
 * 直接要求 Record<string, unknown> 会逼调用方到处做无意义的转换）。
 */
export function withManualHomework<T extends object>(
  backup: BackupDocument,
  homework: readonly T[],
): BackupDocument {
  return {
    ...backup,
    localData: { ...(backup.localData ?? {}), homeworkList: homework.map((item) => ({ ...item })) },
  };
}

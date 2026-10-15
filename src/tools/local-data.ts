/**
 * 本地数据类工具：课表调整规则、手工作业。
 *
 * 这三样在 ChillEast 里原本是设备本地文件（`timetable_rules.json`、
 * `homework_list.json`），但 App 已有一条把本地数据同步到**学习通云盘**的通道。
 * 这里直接复用：读云端最新备份 → 改我们关心的字段 → 写回新备份，于是手机 App
 * 与 MCP 服务操作的是同一份数据。
 *
 * 前提：用户必须在 App 里开过一次「数据同步」，否则云端没有备份文件 —— 这时会
 * 给出可操作的提示（见 BackupNotFoundError）。
 */

import { textResult } from '../mcp/protocol';
import type { ToolContext, ToolDefinition } from '../mcp/registry';
import { SessionExpiredError, runWithSession } from '../auth/session-manager';
import { ensureCloudiskSession } from '../school/hunau/cloudisk';
import {
  BackupNotFoundError,
  readLatestBackup,
  readManualHomework,
  readTimetableRules,
  withManualHomework,
  withTimetableRules,
  writeBackup,
  type BackupDocument,
} from '../school/hunau/backup';
import {
  buildCustomCourseRule,
  buildRescheduleRule,
  buildSuspensionRule,
  weekdayName,
  type TimetableRule,
} from '../school/hunau/timetable-rules';

/** 手工（用户自己加的）作业条目，字段与 Dart `HomeworkModel.toJson` 对齐。 */
interface ManualHomework {
  id: string;
  courseName: string;
  title: string;
  endTime: string | null;
  /** HomeworkStatus 的枚举下标：0=未完成 1=已完成 2=已存档 */
  status: number;
  studentId: string;
  rawTimeStr: string;
  dataUrl: string;
  isManual: true;
  createdAt: string;
  remarks: string;
}

const STATUS_LABELS = ['未完成', '已完成', '已存档'];

function asRule(value: unknown): TimetableRule | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record['id'] !== 'string' || typeof record['type'] !== 'string') return null;
  return {
    id: record['id'],
    type: record['type'] as TimetableRule['type'],
    description: typeof record['description'] === 'string' ? record['description'] : '',
    createdAt: typeof record['createdAt'] === 'string' ? record['createdAt'] : '',
    data:
      typeof record['data'] === 'object' && record['data'] !== null
        ? (record['data'] as Record<string, unknown>)
        : {},
  };
}

function asManualHomework(value: unknown): ManualHomework | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record['id'] !== 'string' || typeof record['title'] !== 'string') return null;
  const status = typeof record['status'] === 'number' ? record['status'] : 0;
  return {
    id: record['id'],
    courseName: typeof record['courseName'] === 'string' ? record['courseName'] : '',
    title: record['title'],
    endTime: typeof record['endTime'] === 'string' ? record['endTime'] : null,
    status: Number.isInteger(status) && status >= 0 && status <= 2 ? status : 0,
    studentId: typeof record['studentId'] === 'string' ? record['studentId'] : '',
    rawTimeStr: typeof record['rawTimeStr'] === 'string' ? record['rawTimeStr'] : '',
    dataUrl: typeof record['dataUrl'] === 'string' ? record['dataUrl'] : '',
    isManual: true,
    createdAt: typeof record['createdAt'] === 'string' ? record['createdAt'] : new Date().toISOString(),
    remarks: typeof record['remarks'] === 'string' ? record['remarks'] : '',
  };
}

/**
 * 统一的「读备份 → 改 → 写回」流程。
 *
 * 注意：读-改-写不是原子的。同一个人同时发起两次写操作，后写的会覆盖先写的。
 * 对个人使用场景可以接受；真要多端并发，需要引入基于文件名/etag 的乐观锁。
 */
async function mutateBackup(
  context: { env: ToolContext['env']; credentials: ToolContext['credentials'] },
  mutate: (backup: BackupDocument) => { backup: BackupDocument; message: string },
): Promise<string> {
  return await runWithSession(context.env, context.credentials, async (session) => {
    const auth = await ensureCloudiskSession(session.session);
    const loaded = await readLatestBackup(session.session, auth);
    const { backup, message } = mutate(loaded.backup);
    const written = await writeBackup(session.session, auth, backup, loaded.slot);
    return `${message}\n（已同步到云端：${written.filename}，手机 App 下次同步即可看到）`;
  });
}

function requireNumber(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`缺少必填参数 ${key}（应为数字）`);
  }
  return value;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

// ---- manage_timetable_rules ----

export function createTimetableRuleTool(): ToolDefinition {
  return {
    name: 'manage_timetable_rules',
    description:
      '管理课表调整：调课、停课、加课、查看与删除。动作：' +
      'list 查询已有调整；add_reschedule 调课（挪动或对调）；add_suspension 停课；' +
      'add_custom_course 加课；delete_rule 按 ruleId 删除；clear_rules 清空。' +
      '调整保存在云端备份里，与手机 App 共用同一份，query_timetable 会自动应用。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'list',
            'add_reschedule',
            'add_suspension',
            'add_custom_course',
            'delete_rule',
            'clear_rules',
          ],
          description: '要执行的操作动作。',
        },
        ruleId: { type: 'string', description: '要删除的规则 ID（action=delete_rule 时必填）。' },
        sourceWeek: { type: 'integer', description: '调课源周次 (1-25)。', minimum: 1, maximum: 25 },
        sourceDayOfWeek: { type: 'integer', description: '调课源星期几 (1-7)。', minimum: 1, maximum: 7 },
        targetWeek: { type: 'integer', description: '调课目标周次 (1-25)。', minimum: 1, maximum: 25 },
        targetDayOfWeek: { type: 'integer', description: '调课目标星期几 (1-7)。', minimum: 1, maximum: 7 },
        courseName: {
          type: 'string',
          description:
            '指定课程名称（可选）。注意是**连续子串**匹配：「高数」匹配不到「高等数学」。',
        },
        mode: {
          type: 'string',
          enum: ['copy', 'move', 'swap'],
          description: '调课方式：copy 复制、move 平移（默认）、swap 对调。',
        },
        sourceStartPeriod: { type: 'integer', description: '调课源节次起始 (1-12)。', minimum: 1, maximum: 12 },
        sourceEndPeriod: { type: 'integer', description: '调课源节次结束 (1-12)。', minimum: 1, maximum: 12 },
        targetStartPeriod: { type: 'integer', description: '调课目标节次起始 (1-12)。', minimum: 1, maximum: 12 },
        targetEndPeriod: { type: 'integer', description: '调课目标节次结束 (1-12)。', minimum: 1, maximum: 12 },
        startWeek: { type: 'integer', description: '停课起始周次 (1-25)。', minimum: 1, maximum: 25 },
        endWeek: { type: 'integer', description: '停课结束周次 (1-25)。', minimum: 1, maximum: 25 },
        startDayOfWeek: { type: 'integer', description: '停课起始星期几 (1-7，默认 1)。', minimum: 1, maximum: 7 },
        endDayOfWeek: { type: 'integer', description: '停课结束星期几 (1-7，默认 7)。', minimum: 1, maximum: 7 },
        startPeriod: { type: 'integer', description: '停课起始节次 (1-12，可选)。', minimum: 1, maximum: 12 },
        endPeriod: { type: 'integer', description: '停课结束节次 (1-12，可选)。', minimum: 1, maximum: 12 },
        customCourseName: { type: 'string', description: '加课名称（action=add_custom_course 时必填）。' },
        teacher: { type: 'string', description: '授课教师（可选）。' },
        classroom: { type: 'string', description: '上课地点（可选）。' },
        weeks: { type: 'string', description: '加课周次，例如 "1-16(周)" 或 "1,3,5(周)"。' },
        customDayOfWeek: { type: 'integer', description: '加课星期几 (1-7)。', minimum: 1, maximum: 7 },
        customStartPeriod: { type: 'integer', description: '加课起始节次 (1-12)。', minimum: 1, maximum: 12 },
        customEndPeriod: { type: 'integer', description: '加课结束节次 (1-12)。', minimum: 1, maximum: 12 },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async handler(args, toolContext: ToolContext) {
      const action = String(args['action'] ?? '');

      // list 是只读的，不必走「改+写回」
      if (action === 'list') {
        return await runWithSession(
          toolContext.env,
          toolContext.credentials,
          async (session) => {
            const auth = await ensureCloudiskSession(session.session);
            const loaded = await readLatestBackup(session.session, auth);
            const rules = readTimetableRules(loaded.backup)
              .map(asRule)
              .filter((rule): rule is TimetableRule => rule !== null);
            if (rules.length === 0) return textResult('当前没有任何课表调整规则。');
            return textResult(
              `共 ${rules.length} 条规则（来自 ${loaded.entry.name}）：\n` +
                JSON.stringify(rules, null, 2),
              { count: rules.length, rules, source: loaded.entry.name },
            );
          },
        );
      }

      const message = await mutateBackup(toolContext, (backup) => {
        const rules = readTimetableRules(backup)
          .map(asRule)
          .filter((rule): rule is TimetableRule => rule !== null);

        switch (action) {
          case 'add_suspension': {
            const startWeek = requireNumber(args, 'startWeek');
            const rule = buildSuspensionRule({
              startWeek,
              endWeek: optionalNumber(args, 'endWeek') ?? startWeek,
              startDayOfWeek: optionalNumber(args, 'startDayOfWeek') ?? 1,
              endDayOfWeek: optionalNumber(args, 'endDayOfWeek') ?? 7,
              courseName: optionalString(args, 'courseName'),
              startPeriod: optionalNumber(args, 'startPeriod'),
              endPeriod: optionalNumber(args, 'endPeriod'),
            });
            return {
              backup: withTimetableRules(backup, [...rules, rule]),
              message: `已添加停课规则：${rule.description}`,
            };
          }

          case 'add_custom_course': {
            const name = optionalString(args, 'customCourseName');
            if (name === undefined) throw new Error('add_custom_course 需要提供 customCourseName。');
            const startPeriod = requireNumber(args, 'customStartPeriod');
            const rule = buildCustomCourseRule({
              courseName: name,
              dayOfWeek: optionalNumber(args, 'customDayOfWeek') ?? 1,
              startPeriod,
              endPeriod: optionalNumber(args, 'customEndPeriod') ?? startPeriod,
              weeks: optionalString(args, 'weeks') ?? '1-16(周)',
              teacher: optionalString(args, 'teacher'),
              classroom: optionalString(args, 'classroom'),
            });
            return {
              backup: withTimetableRules(backup, [...rules, rule]),
              message: `已添加加课规则：${rule.description}`,
            };
          }

          case 'add_reschedule': {
            const sourceWeek = requireNumber(args, 'sourceWeek');
            const targetWeek = requireNumber(args, 'targetWeek');
            const sourceDayOfWeek = requireNumber(args, 'sourceDayOfWeek');
            const targetDayOfWeek = requireNumber(args, 'targetDayOfWeek');
            const rule = buildRescheduleRule({
              sourceWeek,
              targetWeek,
              sourceDayOfWeek,
              targetDayOfWeek,
              mode: optionalString(args, 'mode') ?? 'move',
              courseName: optionalString(args, 'courseName'),
              sourceStartPeriod: optionalNumber(args, 'sourceStartPeriod'),
              sourceEndPeriod: optionalNumber(args, 'sourceEndPeriod'),
              targetStartPeriod: optionalNumber(args, 'targetStartPeriod'),
              targetEndPeriod: optionalNumber(args, 'targetEndPeriod'),
            });
            return {
              backup: withTimetableRules(backup, [...rules, rule]),
              message: `已添加调课规则：${rule.description}`,
            };
          }

          case 'delete_rule': {
            const ruleId = optionalString(args, 'ruleId');
            if (ruleId === undefined) throw new Error('delete_rule 需要提供 ruleId。');
            const next = rules.filter((rule) => rule.id !== ruleId);
            if (next.length === rules.length) {
              throw new Error(`没有找到规则 ${ruleId}。`);
            }
            return {
              backup: withTimetableRules(backup, next),
              message: `已删除规则 ${ruleId}，剩余 ${next.length} 条。`,
            };
          }

          case 'clear_rules':
            return {
              backup: withTimetableRules(backup, []),
              message: `已清空全部课表调整规则（原有 ${rules.length} 条）。`,
            };

          default:
            throw new Error(
              `未知 action：${action}。可用：list / add_reschedule / add_suspension / ` +
                `add_custom_course / delete_rule / clear_rules。`,
            );
        }
      });

      return textResult(message);
    },
  };
}

// ---- 手工作业 ----

function renderManual(list: readonly ManualHomework[]): string {
  if (list.length === 0) return '当前没有手工添加的作业。';
  const lines = list.map((item) => {
    const parts = [item.title];
    if (item.courseName !== '') parts.push(`课程 ${item.courseName}`);
    if (item.endTime !== null) parts.push(`截止 ${item.endTime}`);
    parts.push(`[${STATUS_LABELS[item.status] ?? '未知'}]`);
    if (item.remarks !== '') parts.push(`备注：${item.remarks}`);
    return `- ${parts.join(' | ')}  (id: ${item.id})`;
  });
  return `共 ${list.length} 条手工作业：\n${lines.join('\n')}`;
}

export function createManualHomeworkTools(): ToolDefinition[] {
  const addTool: ToolDefinition = {
    name: 'add_homework',
    description:
      '添加一条手工待办作业（与超星自动抓取的作业分开存放）。' +
      '写入云端备份，手机 App 同步后即可看到。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '作业标题或待办内容（必填）。' },
        courseName: { type: 'string', description: '所属课程（可选，默认「自定义任务」）。' },
        endTime: {
          type: 'string',
          description: '截止时间（可选）。支持 "2026-10-31 23:59" 或 ISO8601。',
        },
        remarks: { type: 'string', description: '备注或补充要求（可选）。' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    async handler(args, toolContext: ToolContext) {
      const title = optionalString(args, 'title');
      if (title === undefined) throw new Error('必须提供 title。');

      const rawEndTime = optionalString(args, 'endTime');
      let endTime: string | null = null;
      if (rawEndTime !== undefined) {
        // "2026-10-31 23:59" 这种没有时区的按**北京时间**理解
        const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(rawEndTime)
          ? `${rawEndTime.replace(' ', 'T')}:00+08:00`
          : rawEndTime;
        const parsed = new Date(normalized);
        if (Number.isNaN(parsed.getTime())) {
          throw new Error(`endTime 无法解析：${rawEndTime}。请用 "2026-10-31 23:59" 或 ISO8601。`);
        }
        endTime = parsed.toISOString();
      }

      const message = await mutateBackup(toolContext, (backup) => {
        const list = readManualHomework(backup)
          .map(asManualHomework)
          .filter((item): item is ManualHomework => item !== null);

        const created: ManualHomework = {
          id: `manual_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
          courseName: optionalString(args, 'courseName') ?? '自定义任务',
          title,
          endTime,
          status: 0,
          studentId: '',
          rawTimeStr: '',
          dataUrl: '',
          isManual: true,
          createdAt: new Date().toISOString(),
          remarks: optionalString(args, 'remarks') ?? '',
        };

        return {
          backup: withManualHomework(backup, [...list, created]),
          message: `已添加手工作业：《${created.title}》${endTime === null ? '' : `，截止 ${endTime}`}`,
        };
      });

      return textResult(message);
    },
  };

  const completeTool: ToolDefinition = {
    name: 'complete_homework',
    description:
      '把一条**手工添加**的作业标记为已完成（自动抓取的超星作业不能在这里改）。' +
      '用 id 或 title 指定，两者都不给会先列出可选项。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '手工作业的 id（add_homework 时生成，或先 list 查看）。' },
        title: { type: 'string', description: '按标题匹配（连续子串，忽略大小写）。' },
        status: {
          type: 'string',
          enum: ['completed', 'pending', 'archived'],
          description: '目标状态，默认 completed。',
        },
      },
      additionalProperties: false,
    },
    async handler(args, toolContext: ToolContext) {
      const id = optionalString(args, 'id');
      const title = optionalString(args, 'title');
      const statusArg = optionalString(args, 'status') ?? 'completed';
      const targetStatus = statusArg === 'pending' ? 0 : statusArg === 'archived' ? 2 : 1;

      const message = await mutateBackup(toolContext, (backup) => {
        const list = readManualHomework(backup)
          .map(asManualHomework)
          .filter((item): item is ManualHomework => item !== null);

        if (id === undefined && title === undefined) {
          return { backup, message: `请指定 id 或 title。\n${renderManual(list)}` };
        }

        const matched = list.filter((item) => {
          if (id !== undefined) return item.id === id;
          if (title === undefined) return false;
          return item.title.toLowerCase().includes(title.toLowerCase());
        });

        if (matched.length === 0) {
          return { backup, message: `没有找到匹配的手工作业。\n${renderManual(list)}` };
        }
        if (matched.length > 1) {
          return {
            backup,
            message: `匹配到 ${matched.length} 条，请用 id 精确指定：\n${renderManual(matched)}`,
          };
        }

        const target = matched[0];
        const updated = list.map((item) =>
          item.id === target.id ? { ...item, status: targetStatus } : item,
        );
        return {
          backup: withManualHomework(backup, updated),
          message: `已把《${target.title}》标记为「${STATUS_LABELS[targetStatus]}」。`,
        };
      });

      return textResult(message);
    },
  };

  return [addTool, completeTool];
}

export { asRule };

/**
 * 给 query_timetable 用：读出课表调整规则。
 * 读不到就返回空数组 + 说明 —— 绝不能因为云盘读不到就让课表查不出来。
 */
export async function loadTimetableRules(
  env: ToolContext['env'],
  credentials: ToolContext['credentials'],
): Promise<{ rules: TimetableRule[]; note: string | null }> {
  try {
    return await runWithSession(env, credentials, async (session) => {
      const auth = await ensureCloudiskSession(session.session);
      const loaded = await readLatestBackup(session.session, auth);
      const rules = readTimetableRules(loaded.backup)
        .map(asRule)
        .filter((rule): rule is TimetableRule => rule !== null);
      return { rules, note: null };
    });
  } catch (error) {
    if (error instanceof BackupNotFoundError) {
      // 没开过同步是很常见的情况，不该当成错误，也不该每次都提示
      return { rules: [], note: null };
    }
    return {
      rules: [],
      note: `未能读取课表调整规则（${error instanceof Error ? error.message : '未知错误'}），本次按原始课表显示。`,
    };
  }
}

/** 给 query_homework 用：读出手工作业（失败时返回空数组，不影响网络部分）。 */
export async function loadManualHomework(
  env: ToolContext['env'],
  credentials: ToolContext['credentials'],
): Promise<{ items: ManualHomework[]; note: string | null }> {
  try {
    return await runWithSession(env, credentials, async (session) => {
      const auth = await ensureCloudiskSession(session.session);
      const loaded = await readLatestBackup(session.session, auth);
      const items = readManualHomework(loaded.backup)
        .map(asManualHomework)
        .filter((item): item is ManualHomework => item !== null);
      return { items, note: null };
    });
  } catch (error) {
    if (error instanceof BackupNotFoundError) {
      return { items: [], note: error.message };
    }
    if (error instanceof SessionExpiredError) {
      return { items: [], note: '超星会话已失效，未能读取云端的手工作业。' };
    }
    return {
      items: [],
      note: `未能读取云端手工作业：${error instanceof Error ? error.message : '未知错误'}`,
    };
  }
}

export { weekdayName };

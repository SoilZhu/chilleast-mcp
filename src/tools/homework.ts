/**
 * MCP Tool: 作业查询 (query_homework)
 *
 * 全量对齐 ChillEast `lib/core/mcp/tools/homework_tools.dart` 的同名工具，
 * 但按用户决定**只做网络部分**：实时从超星 mooc1-api 拉取并解析，
 * 不读也不写设备端的手工待办（那部分在服务端不做）。
 */

import { textResult } from '../mcp/protocol';
import { loadManualHomework } from './local-data';
import type { ToolContext, ToolDefinition } from '../mcp/registry';
import { runWithSession } from '../auth/session-manager';
import { fetchRemoteHomework } from '../school/hunau/chaoxing-study';
import {
  filterHomework,
  homeworkToJson,
  parseHomeworkFilter,
  sortHomework,
} from '../school/hunau/homework-model';

export function createHomeworkTools(): ToolDefinition[] {
  const queryHomework: ToolDefinition = {
    name: 'query_homework',
    description:
      '查询学生的超星/学习通作业列表（实时抓取）。支持按状态（待完成 pending、已完成 completed、' +
      '已存档 archived 或全部 all）与课程名称、关键词筛选。返回标题、课程、截止时间与状态。',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['all', 'pending', 'completed', 'archived'],
          description:
            '作业状态筛选：pending(待完成/未提交), completed(已完成/已提交), archived(已过期/已存档), all(全部)。默认为 pending。',
          default: 'pending',
        },
        courseName: {
          type: 'string',
          description: '按课程名称关键词过滤作业。',
        },
        keyword: {
          type: 'string',
          description: '按作业标题或课程名关键词搜索。',
        },
        forceRefresh: {
          type: 'boolean',
          description:
            '是否重新抓取最新作业数据。服务端每次调用都是实时抓取，本参数仅为兼容 ChillEast 而保留。',
          default: false,
        },
      },
      additionalProperties: false,
    },
    async handler(args, ctx: ToolContext) {
      const filter = parseHomeworkFilter(args);

      const entries = await runWithSession(ctx.env, ctx.credentials, async (context) => {
        // 同一批作业的倒计时用同一个基准时间（对齐 Dart 的 `final now = DateTime.now()`）
        return await fetchRemoteHomework(context.session, Date.now());
      });

      const filtered = sortHomework(filterHomework(entries, filter));
      const homeworkList = filtered.map(homeworkToJson);

      // 手工添加的待办（存在云端备份里，与手机 App 共用同一份）。
      // 读不到不影响网络作业的返回 —— 只是附加一段说明。
      const manual = await loadManualHomework(ctx.env, ctx.credentials);

      const sections: string[] = [];
      sections.push(
        homeworkList.length === 0
          ? `没有符合条件的超星作业（状态筛选：${filter.status}）。`
          : `超星作业 ${homeworkList.length} 条：\n${JSON.stringify(homeworkList, null, 2)}`,
      );
      sections.push(
        manual.items.length === 0
          ? '手工待办：无。'
          : `手工待办 ${manual.items.length} 条：\n${JSON.stringify(manual.items, null, 2)}`,
      );
      if (manual.note !== null) sections.push(`（${manual.note}）`);

      return textResult(sections.join('\n\n'), {
        filterStatus: filter.status,
        totalCount: homeworkList.length,
        fetchedCount: entries.length,
        homeworkList,
        manualHomework: manual.items,
        manualNote: manual.note,
      });
    },
  };

  return [queryHomework];
}

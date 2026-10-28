/**
 * MCP Tool: 作业查询 (query_homework)
 * 迁移至 api.chilleast.soilzhu.su/api/study/homework 与云备份通道。
 */

import { textResult } from '../mcp/protocol';
import type { ToolContext, ToolDefinition } from '../mcp/registry';
import { callRelayApi } from '../api/client';
import {
  parseHomeworkFilter,
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
      const query = new URLSearchParams({
        status: filter.status,
        ...(filter.courseName ? { courseName: filter.courseName } : {}),
        ...(filter.keyword ? { keyword: filter.keyword } : {}),
      }).toString();

      const homeworkListPromise = callRelayApi<any[]>(ctx, `/api/study/homework?${query}`);
      const backupPromise = callRelayApi<any>(ctx, '/api/study/cloudisk/backup').catch(() => null);

      const [homeworkRes, backup] = await Promise.all([homeworkListPromise, backupPromise]);
      const homeworkList = Array.isArray(homeworkRes) ? homeworkRes : [];
      const manualItems = Array.isArray(backup?.manualHomework) ? backup.manualHomework : [];
      const manualNote = backup?.fileName ? `来自云端备份 ${backup.fileName}` : null;

      const sections: string[] = [];
      sections.push(
        homeworkList.length === 0
          ? `没有符合条件的超星作业（状态筛选：${filter.status}）。`
          : `超星作业 ${homeworkList.length} 条：\n${JSON.stringify(homeworkList, null, 2)}`,
      );
      sections.push(
        manualItems.length === 0
          ? '手工待办：无。'
          : `手工待办 ${manualItems.length} 条：\n${JSON.stringify(manualItems, null, 2)}`,
      );
      if (manualNote !== null) sections.push(`（${manualNote}）`);

      return textResult(sections.join('\n\n'), {
        filterStatus: filter.status,
        totalCount: homeworkList.length,
        fetchedCount: homeworkList.length,
        homeworkList,
        manualHomework: manualItems,
        manualNote,
      });
    },
  };

  return [queryHomework];
}

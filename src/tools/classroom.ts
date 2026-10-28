/**
 * 空教室查询 —— 迁移至 api.chilleast.soilzhu.su/api/academic/classrooms。
 * 对齐 ChillEast `ClassroomService`。
 */

import { textResult } from '../mcp/protocol';
import type { ToolContext, ToolDefinition } from '../mcp/registry';
import { callRelayApi } from '../api/client';

export function createClassroomTool(): ToolDefinition {
  return {
    name: 'query_empty_classrooms',
    description:
      '查询湖南农业大学空闲教室。不传任何参数时返回可选的教学楼、节次、周次、星期列表；' +
      '带上 building / week / section / day 四个参数则返回该条件下的空闲教室。',
    inputSchema: {
      type: 'object',
      properties: {
        building: {
          type: 'string',
          description: '教学楼名称，取值来自上一次不带参数调用的 buildings 列表。',
        },
        week: {
          type: 'string',
          description: '第几周（对应接口的 zc 参数），取值来自 weeks 列表。',
        },
        section: {
          type: 'string',
          description: '节次，取值来自 sections 列表，例如「第一大节」。',
        },
        day: {
          type: 'string',
          description: '星期几，取值来自 days 列表的 value 字段，例如「1」表示周一。',
        },
      },
      additionalProperties: false,
    },
    async handler(args, toolContext: ToolContext) {
      const building = typeof args['building'] === 'string' ? args['building'] : '';
      const week = typeof args['week'] === 'string' ? args['week'] : '';
      const section = typeof args['section'] === 'string' ? args['section'] : '';
      const day = typeof args['day'] === 'string' ? args['day'] : '';

      if (building === '' || week === '' || section === '' || day === '') {
        const options = await callRelayApi<any>(toolContext, '/api/academic/classrooms');
        return textResult(
          '请从下列取值中挑选 building / week / section / day 后再次调用：\n' +
            JSON.stringify(options, null, 2),
          options,
        );
      }

      const query = new URLSearchParams({ building, week, section, day }).toString();
      const res = await callRelayApi<any>(toolContext, `/api/academic/classrooms?${query}`);
      const rows = Array.isArray(res?.classrooms)
        ? res.classrooms
        : Array.isArray(res?.data)
          ? res.data
          : Array.isArray(res)
            ? res
            : [];

      if (rows.length === 0) {
        return textResult('该条件下没有空闲教室。');
      }
      return textResult(
        `共 ${rows.length} 条空闲教室记录：\n` + JSON.stringify(rows, null, 2),
        { count: rows.length, rows },
      );
    },
  };
}

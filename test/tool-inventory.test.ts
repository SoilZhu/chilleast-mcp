import { describe, expect, it } from 'vitest';
import { buildRegistry } from '../src/tools';

/**
 * 工具清单契约测试。以 ChillEast `lib/core/mcp/services/mcp_tool_registry.dart` 的注册表为准
 * （28 个唯一工具 + 7 个别名）：任何工具漏了、改名了，这里会直接报出来。明确不做的 3 个
 * （用户决定）—— manage_timetable_rules / add_homework / complete_homework，它们是纯设备
 * 本地状态，与网络无关；`query_homework` 只做网络部分（原版会合并设备上的手工待办）。
 */

/** 必须存在的工具名（含别名），全部来自 ChillEast 注册表。 */
const CHILLEAST_TOOLS = [
  // 移动教务
  'query_timetable',
  'query_scores',
  // 融合门户
  'query_empty_classrooms',
  // 超星通知
  'query_notices',
  // 学工系统
  'query_questionnaires',
  'query_questionnaire_detail',
  'submit_questionnaire',
  'query_leaves',
  'query_leave_detail',
  'submit_leave',
  // 作业与考试（mooc1-api）
  'query_homework',
  'query_exams',
  'query_exam_schedule',
  // 一卡通财务平台
  'query_campus_card_balance',
  'recharge_electricity',
  'query_electricity',
  'query_card_transactions',
  'query_bill',
  // 图书馆
  'query_library_last_seat',
  'reserve_library_seat',
  'quick_reserve_library_seat',
  'quick_reserve',
  'search_library_books',
  'query_books',
  'query_library_book_detail',
  'query_book_detail',
  // 报修
  'query_repairs',
  'query_repair_orders',
  'query_repair_detail',
  'submit_repair_order',
  'cancel_repair_order',
  // 阳光服务
  'query_sunshine_departments',
  'submit_sunshine_letter',
  // 本地数据类（走学习通云盘备份通道）
  'manage_timetable_rules',
  'add_homework',
  'complete_homework',
] as const;

/**
 * 本项目额外提供的工具，ChillEast 里**没有**。
 * 单独列出来是为了让偏差可见，而不是混在"已实现"里。
 */
const EXTENSIONS = ['query_notice_detail'] as const;

/** 现在没有"明确不做"的工具了 —— 全部 28 个都已实现。 */
const DELIBERATELY_OMITTED: readonly string[] = [];

describe('工具清单', () => {
  const registry = buildRegistry();
  const names = registry.list().map((tool) => tool.name);

  it('ChillEast 的网络工具全部已实现', () => {
    const missing = CHILLEAST_TOOLS.filter((name) => !names.includes(name));
    expect(missing, `缺少工具：${missing.join(', ')}`).toEqual([]);
  });

  it('额外扩展的工具是已知且有限的', () => {
    const extra = names.filter(
      (name) =>
        !(CHILLEAST_TOOLS as readonly string[]).includes(name) &&
        !(EXTENSIONS as readonly string[]).includes(name),
    );
    expect(extra, `出现了未登记的额外工具：${extra.join(', ')}`).toEqual([]);
  });

  it('没有"明确不做"的工具了（原本那 3 个已通过云盘备份通道实现）', () => {
    const unexpected = DELIBERATELY_OMITTED.filter((name) => names.includes(name));
    expect(unexpected, `不该出现：${unexpected.join(', ')}`).toEqual([]);
  });

  it('没有重名，也没有空描述', () => {
    expect(new Set(names).size).toBe(names.length);
    for (const tool of registry.list()) {
      expect(tool.description.trim().length).toBeGreaterThan(10);
    }
  });

  it('每个工具的 inputSchema 都是合法的 object schema', () => {
    for (const tool of registry.list()) {
      const schema = tool.inputSchema as {
        type?: string;
        properties?: unknown;
        additionalProperties?: unknown;
      };
      expect(schema.type, `${tool.name} 的 type`).toBe('object');
      expect(typeof schema.properties, `${tool.name} 的 properties`).toBe('object');
      // 禁止客户端传未声明的参数，避免模型臆造参数被静默忽略
      expect(schema.additionalProperties, `${tool.name} 的 additionalProperties`).toBe(false);
    }
  });

  it('别名与主实现同名不同名，且都能查到', () => {
    // 别名指向同一实现，行为必须一致
    const aliasPairs: Array<[string, string]> = [
      ['query_electricity', 'recharge_electricity'],
      ['query_bill', 'query_card_transactions'],
      ['quick_reserve', 'quick_reserve_library_seat'],
      ['query_books', 'search_library_books'],
      ['query_book_detail', 'query_library_book_detail'],
      ['query_repair_orders', 'query_repairs'],
      ['query_exam_schedule', 'query_exams'],
    ];
    for (const [alias, primary] of aliasPairs) {
      expect(registry.get(alias), `别名 ${alias} 未注册`).toBeDefined();
      expect(registry.get(primary), `主工具 ${primary} 未注册`).toBeDefined();
    }
  });

  it('工具数量与预期一致（便于发现意外新增/删除）', () => {
    console.log(`  已注册工具数：${registry.size}`);
    expect(registry.size).toBe(CHILLEAST_TOOLS.length + EXTENSIONS.length);
  });
});

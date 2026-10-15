import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/mcp/registry';
import { createHomeworkTools } from '../src/tools/homework';
import { createExamTools } from '../src/tools/exam';

/**
 * 注册契约测试。`src/tools/index.ts` 由上层统一注册（本模块不修改它），
 * 这里模拟一遍注册过程，提前把 `test/tool-inventory.test.ts` 会检查的约定固定下来：
 * 工具名、别名、schema 形状、描述非空、不重名。
 */

function buildChaoxingRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of createHomeworkTools()) registry.register(tool);
  for (const tool of createExamTools()) registry.register(tool);
  return registry;
}

describe('作业 / 考试工具注册契约', () => {
  it('注册 3 个工具名：query_homework + query_exams + 别名', () => {
    const registry = buildChaoxingRegistry();
    expect(registry.list().map((tool) => tool.name).sort()).toEqual([
      'query_exam_schedule',
      'query_exams',
      'query_homework',
    ]);
    expect(registry.size).toBe(3);
  });

  it('每个工具都是合法的 MCP object schema', () => {
    const registry = buildChaoxingRegistry();
    for (const tool of registry.list()) {
      expect(tool.inputSchema['type'], `${tool.name} 的 type`).toBe('object');
      expect(typeof tool.inputSchema['properties'], `${tool.name} 的 properties`).toBe('object');
      expect(tool.inputSchema['additionalProperties'], `${tool.name} 的 additionalProperties`).toBe(
        false,
      );
      expect(tool.description.trim().length).toBeGreaterThan(10);
    }
  });

  it('query_exam_schedule 与 query_exams 是同一实现', () => {
    const registry = buildChaoxingRegistry();
    const primary = registry.get('query_exams');
    const alias = registry.get('query_exam_schedule');
    expect(alias?.handler).toBe(primary?.handler);
    expect(alias?.inputSchema).toEqual(primary?.inputSchema);
  });

  it('工具名不重复（注册过程本身就会抛错）', () => {
    const registry = new ToolRegistry();
    const all = [...createHomeworkTools(), ...createExamTools()];
    for (const tool of all) registry.register(tool);
    expect(registry.size).toBe(all.length);
  });
});

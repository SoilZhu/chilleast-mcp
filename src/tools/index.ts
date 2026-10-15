/**
 * 所有工具的汇总注册。
 *
 * 命名与 ChillEast `lib/core/mcp/services/mcp_tool_registry.dart` 对齐，
 * 别名（query_electricity / query_bill / quick_reserve / query_books /
 * query_book_detail / query_repair_orders / query_exam_schedule）由各自的
 * 工厂函数一并产出。
 *
 * 明确不实现（纯设备本地状态，与网络无关）：
 *   manage_timetable_rules / add_homework / complete_homework
 * `query_homework` 只做网络部分，不合并设备上的手工待办。
 */

import { ToolRegistry } from '../mcp/registry';
import { createClassroomTool } from './classroom';
import { createNoticeTools } from './notices';
import { createXgxtTools } from './xgxt';
import { createYdjwxtTools } from './ydjwxt';
import { createHomeworkTools } from './homework';
import { createExamTools } from './exam';
import { createFinServTools } from './finserv';
import { createLibraryTools } from './library';
import { createRepairTools } from './repair';
import { createSunshineTools } from './sunshine';
import { createManualHomeworkTools, createTimetableRuleTool } from './local-data';

export function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const register = (tools: ReturnType<typeof createClassroomTool>[]) => {
    for (const tool of tools) registry.register(tool);
  };

  // 融合门户会话（FUSION Cookie）
  register([createClassroomTool()]);

  // 超星会话（登录链直接产出的 .chaoxing.com Cookie）
  register(createNoticeTools());
  register(createHomeworkTools());
  register(createExamTools());

  // 学工系统会话（TGC -> CAS 换票 -> JSESSIONID）
  register(createXgxtTools());

  // 移动教务：学号+密码直接换 JWT（纯 HTTP）
  register(createYdjwxtTools());

  // 一卡通财务平台（超星 OAuth 换 openid + AES-ECB 载荷）
  register(createFinServTools());

  // 图书馆（office.chaoxing 座位 + superlib 无需鉴权的 OPAC）
  register(createLibraryTools());

  // 报修（CAS 换票 + JSON-RPC）与阳光服务（CAS OAuth2 + GBK）
  register(createRepairTools());
  register(createSunshineTools());

  // 本地数据类：原本是设备文件，现在走学习通云盘的备份通道，
  // 与手机 App 共用同一份数据
  register([createTimetableRuleTool()]);
  register(createManualHomeworkTools());

  return registry;
}

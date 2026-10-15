/**
 * 阳光服务工具（sun.hunau.edu.cn）。
 *
 * 对齐 ChillEast `lib/core/mcp/tools/sunshine_tool.dart`：
 * 工具名、参数名与两阶段确认（`confirmed`）语义保持一致。
 * 链路说明（CAS OAuth2 逐跳 + GBK 解码）见 `src/school/hunau/sun.ts` 顶部注释。
 */

import { errorResult, textResult } from '../mcp/protocol';
import type { McpToolResult } from '../mcp/protocol';
import type { ToolContext, ToolDefinition } from '../mcp/registry';
import { runWithSession } from '../auth/session-manager';
import {
  SUNSHINE_TYPE_NAMES,
  defaultSunshineFinishTime,
  fetchSunshineForm,
  findSunshineDepartment,
  normalizeSunshineType,
  submitSunshineLetter,
} from '../school/hunau/sun';

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function render(payload: Record<string, unknown>): McpToolResult {
  return textResult(JSON.stringify(payload, null, 2), payload);
}

export function createSunshineTools(): ToolDefinition[] {
  const departmentsTool: ToolDefinition = {
    name: 'query_sunshine_departments',
    description:
      '查询学校“阳光服务”平台当前所有可受理诉求的部门/单位列表（如后勤保卫部、教务处、图书馆、校医院等）。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async handler(_args, toolContext: ToolContext) {
      return await runWithSession(toolContext.env, toolContext.credentials, async (context) => {
        const form = await fetchSunshineForm(context.session);
        return render({
          success: true,
          userName: form.identity.name,
          departmentCount: form.departments.length,
          departments: form.departments.map((department) => ({
            code: department.code,
            name: department.name,
          })),
        });
      });
    },
  };

  const submitTool: ToolDefinition = {
    name: 'submit_sunshine_letter',
    description:
      '向学校“阳光服务”平台快速提交诉求表单（支持咨询、建议、投诉、表扬）。支持自动识别部门并填充个人信息。' +
      '【重要】：在正式提交前，必须向用户核对受理单位、类型、标题和诉求正文，征得用户明确同意确认后，传入 confirmed=true 方可真正提交。',
    inputSchema: {
      type: 'object',
      properties: {
        department: {
          type: 'string',
          description:
            '受理部门名称或关键词（如“后勤保卫部”、“教务处”、“图书馆”、“信息与网络中心”等，支持模糊匹配）。',
        },
        title: {
          type: 'string',
          description: '诉求标题（必填，要求简明准确，50字以内）。',
        },
        content: {
          type: 'string',
          description: '诉求详细内容（必填，清晰阐述遇到的问题、具体诉求或建议）。',
        },
        type: {
          type: 'string',
          description:
            '诉求类别：2-咨询, 3-建议, 1-投诉, 4-表扬。可传数字或汉字（如“咨询”、“建议”），默认为“咨询”。',
          default: '2',
        },
        phone: {
          type: 'string',
          description: '联系电话（可选，默认使用学号绑定的手机号）。',
        },
        email: {
          type: 'string',
          description: '电子邮箱（可选，默认使用预留邮箱）。',
        },
        finishTime: {
          type: 'string',
          description: '期望解决时间，格式为 YYYY-MM-DD（可选，不填默认7天后）。',
        },
        confirmed: {
          type: 'boolean',
          description:
            '用户是否已明确同意并确认提交表单。默认为 false。' +
            '【重要】：首次调用时若用户未对整理好的具体表单内容（部门、标题、正文等）做最终确认，请保持 false。' +
            '工具将返回待确认的表单预览；待用户明确确认后，再将 confirmed 设为 true 真正完成投递。',
          default: false,
        },
      },
      additionalProperties: false,
      required: ['department', 'title', 'content'],
    },
    async handler(args, toolContext) {
      const deptInput = stringArg(args, 'department').trim();
      const title = stringArg(args, 'title').trim();
      const content = stringArg(args, 'content').trim();
      const typeInput = stringArg(args, 'type').trim();
      const confirmed = args['confirmed'] === true;

      if (deptInput === '') return errorResult('受理部门不能为空，请输入或指定部门');
      if (title === '') return errorResult('诉求标题不能为空');
      if (content === '') return errorResult('诉求正文内容不能为空');

      return await runWithSession(toolContext.env, toolContext.credentials, async (context) => {
        // 拿身份信息 + 可受理单位（顺带确认会话可用）
        const form = await fetchSunshineForm(context.session);
        const matched = findSunshineDepartment(form.departments, deptInput);
        if (matched === null) {
          const sample = form.departments
            .slice(0, 8)
            .map((department) => department.name)
            .join('、');
          return errorResult(
            `未找到名为“${deptInput}”的受理部门。可选部门参考：${sample} 等，` +
              '可调用 query_sunshine_departments 查看完整列表。',
          );
        }

        const typeCode = normalizeSunshineType(typeInput === '' ? '2' : typeInput);
        const typeName = SUNSHINE_TYPE_NAMES[typeCode] ?? '咨询';
        const phoneArg = stringArg(args, 'phone').trim();
        const emailArg = stringArg(args, 'email').trim();
        const phone = phoneArg !== '' ? phoneArg : form.identity.phone;
        const email = emailArg !== '' ? emailArg : form.identity.email;
        const finishTimeArg = stringArg(args, 'finishTime').trim();
        const finishTime = finishTimeArg !== '' ? finishTimeArg : defaultSunshineFinishTime();

        if (!confirmed) {
          return render({
            status: 'requires_confirmation',
            needsUserConsent: true,
            message:
              '阳光服务诉求表单已就绪。【重要】：请向用户呈现以下待提交的诉求核对信息，' +
              '并明确征得用户的同意与确认。用户明确同意确认后，传入 confirmed=true 重新调用本工具正式提交。',
            formPreview: {
              submitterName: form.identity.name,
              departmentName: matched.name,
              departmentCode: matched.code,
              typeName,
              typeCode,
              title,
              content,
              phone,
              email,
              finishTime,
            },
          });
        }

        const result = await submitSunshineLetter(context.session, {
          identity: form.identity,
          department: matched,
          type: typeCode,
          title,
          content,
          phone,
          email,
          finishTime,
        });

        if (result === '1') {
          return render({
            status: 'success',
            message: `诉求提交成功！阳光服务平台已受理并流转至【${matched.name}】。`,
            department: matched.name,
            type: typeName,
            title,
          });
        }
        if (result === '2') {
          return render({
            status: 'success',
            message: `诉求提交成功，等待平台审核后将流转至【${matched.name}】。`,
            department: matched.name,
            type: typeName,
            title,
          });
        }
        return errorResult(`提交未被服务器成功处理，状态码: ${result}`);
      });
    },
  };

  return [departmentsTool, submitTool];
}

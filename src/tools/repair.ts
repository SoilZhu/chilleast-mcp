/**
 * 报修平台工具（bxpt.hunau.edu.cn）。
 *
 * 对齐 ChillEast `lib/core/mcp/tools/repair_tool.dart`：
 * 工具名、参数名、两阶段确认（`confirmed`）语义都保持一致。
 *
 * 唯一的入参改动：Dart 用设备上的本地图片路径（`image_path` / `image_paths`），
 * 服务端没有文件系统，改成 `imageBase64` / `imageUrl`（详见 submit_repair_order 的描述）。
 */

import { errorResult, textResult } from '../mcp/protocol';
import type { McpToolResult } from '../mcp/protocol';
import type { ToolContext, ToolDefinition } from '../mcp/registry';
import { runWithSession, type SessionContext } from '../auth/session-manager';
import {
  canCancelRepairOrder,
  connectRepair,
  decodeImageBase64,
  downloadImage,
  formatChinaDate,
  formatChinaIso,
  isChoiceField,
  isDateField,
  isUploadField,
  parseDateToTimestamp,
  resolveRepairCatalog,
  type RepairClient,
  type RepairForm,
  type RepairImage,
  type RepairOrder,
} from '../school/hunau/bxpt';

/** 预约维修时段的默认字典类型（Dart 里的兜底 referenceType）。 */
const DEFAULT_TIME_LOOKUP = '3965f192-b6ed-11eb-8b80-af0eafc5dd38';

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

/** Dart `_formatOrder`：只暴露模型需要的字段，时间格式化成中国时区的 YYYY/MM/DD。 */
function formatOrder(order: RepairOrder): Record<string, unknown> {
  return {
    id: order.id,
    code: order.code,
    title: order.title,
    catalog: order.catalog,
    department: order.department,
    status: order.status,
    createdAt: order.createdAtMs === null ? null : formatChinaDate(order.createdAtMs),
    description: order.description,
  };
}

/** 中国时区的今天，`YYYY/MM/DD`（Dart 用设备本地日期）。 */
function todayInChina(): string {
  return formatChinaDate(Date.now());
}

function identityOf(context: SessionContext): {
  realName: string;
  username: string;
  userId: string;
} {
  return {
    realName: context.identity?.realName ?? '',
    username: context.identity?.username ?? '',
    userId: context.identity?.userId ?? '',
  };
}

function render(payload: Record<string, unknown>): McpToolResult {
  return textResult(JSON.stringify(payload, null, 2), payload);
}

/**
 * 按字段配置填充提交值（Dart `RepairSubmitTool` 里的 4.2 循环）。
 * 顺序与判据逐条对应，选择器类字段会去拉候选项做关键词匹配。
 */
async function collectSubmitValues(
  client: RepairClient,
  form: RepairForm,
  options: {
    location: string;
    description: string;
    title: string;
    phone: string;
    appointmentDate: string;
    appointmentTime: string;
    uploadedCount: number;
  },
): Promise<Record<string, unknown>> {
  const values: Record<string, unknown> = {};

  for (const field of form.fields) {
    if (field.hidden || field.readonly) continue;

    // 附件字段：传已上传的张数
    if (isUploadField(field)) {
      values[field.name] = options.uploadedCount;
      continue;
    }

    // 预约日期
    if (isDateField(field) || field.name === 'yyrq') {
      values[field.name] =
        parseDateToTimestamp(options.appointmentDate) ?? options.appointmentDate;
      continue;
    }

    // 预约时间段
    if (field.name === 'yywxsj') {
      if (options.appointmentTime !== '') {
        values[field.name] = options.appointmentTime;
      } else {
        // 未指定就取字典里的第一个可用时段（Dart 的兜底是 14_15）
        const choices = await client.lookup(field.referenceType ?? DEFAULT_TIME_LOOKUP);
        values[field.name] = choices.length > 0 ? choices[0].id : '14_15';
      }
      continue;
    }

    // 手机号
    if (field.name === 'sjhm' || field.label.includes('手机') || field.label.includes('电话')) {
      values[field.name] =
        options.phone !== ''
          ? options.phone
          : (form.initialValues[field.name] ?? client.account.username);
      continue;
    }

    // 姓名
    if (field.name === 'xm' || field.label.includes('姓名')) {
      values[field.name] = form.initialValues[field.name] ?? client.account.realName;
      continue;
    }

    // 详细位置 / 房间号
    if (
      field.name === 'xxwzhfjy' ||
      field.label.includes('详细位置') ||
      field.label.includes('房间号')
    ) {
      values[field.name] = options.location !== '' ? options.location : options.description;
      continue;
    }

    // 问题描述 / 补充说明
    if (
      field.name === 'wtmsh' ||
      field.name === 'bchshm' ||
      field.label.includes('问题描述') ||
      field.label.includes('补充说明')
    ) {
      values[field.name] = options.description;
      continue;
    }

    // 工单标题
    if (field.name === 'title' || field.label.includes('标题')) {
      values[field.name] = options.title;
      continue;
    }

    // 其余选择器（区域、楼栋、项目、设施等）：按地点/描述关键词尽量选中
    if (isChoiceField(field)) {
      try {
        const choices = await client.choicesForField(field);
        if (choices.length > 0) {
          const searchContext = `${options.location} ${options.description}`;
          const matched = choices.find(
            (choice) =>
              searchContext.includes(choice.label) || choice.label.includes(options.location),
          );
          values[field.name] = (matched ?? choices[0]).id;
        }
      } catch {
        // 候选项拿不到就留给服务端校验
      }
    }
  }

  return values;
}

/** 收集工具入参里的图片（base64 优先，其次 URL；两者都给就都上传）。 */
async function collectImages(args: Record<string, unknown>): Promise<RepairImage[]> {
  const fallbackName = stringArg(args, 'imageName').trim() || `repair-${Date.now()}`;
  const images: RepairImage[] = [];

  const base64Input = stringArg(args, 'imageBase64').trim();
  if (base64Input !== '') images.push(decodeImageBase64(base64Input, fallbackName));

  const urlInput = stringArg(args, 'imageUrl').trim();
  if (urlInput !== '') images.push(await downloadImage(urlInput, fallbackName));

  return images;
}

export function createRepairTools(): ToolDefinition[] {
  // ---- query_repairs / query_repair_orders（同一实现的别名） ----
  const listInputSchema = {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        description: '按状态过滤：处理中、已完成、草稿箱、全部。默认为“处理中”。',
        default: '处理中',
      },
    },
    additionalProperties: false,
  } as const;

  const listDescription =
    '查询学校报修平台当前用户的报修工单列表（支持查询“处理中”、“已完成”、“草稿箱”或“全部”）。' +
    '返回工单编号、标题、分类、创建日期及处理状态。';

  async function listHandler(
    args: Record<string, unknown>,
    toolContext: ToolContext,
  ): Promise<McpToolResult> {
    const requested = stringArg(args, 'status').trim();
    const status = requested === '' ? '处理中' : requested;

    return await runWithSession(toolContext.env, toolContext.credentials, async (context) => {
      const client = await connectRepair(context.session, identityOf(context));

      let orders: RepairOrder[];
      if (status.includes('草稿')) {
        orders = await client.fetchOrders({ ongoing: false, isDraft: true });
      } else if (status.includes('已完成') || status.includes('完成')) {
        orders = await client.fetchOrders({ ongoing: false });
      } else if (status.includes('全')) {
        const [ongoing, finished, drafts] = await Promise.all([
          client.fetchOrders({ ongoing: true }),
          client.fetchOrders({ ongoing: false }),
          client.fetchOrders({ ongoing: false, isDraft: true }),
        ]);
        orders = [...ongoing, ...finished, ...drafts];
      } else {
        orders = await client.fetchOrders({ ongoing: true });
      }

      return render({
        success: true,
        count: orders.length,
        status,
        orders: orders.map(formatOrder),
      });
    });
  }

  const listTool: ToolDefinition = {
    name: 'query_repairs',
    description: listDescription,
    inputSchema: listInputSchema,
    handler: listHandler,
  };

  /** 别名：与 `query_repairs` 共用同一个 handler，行为完全一致。 */
  const listAliasTool: ToolDefinition = {
    name: 'query_repair_orders',
    description: `${listDescription}（与 query_repairs 等价的别名。）`,
    inputSchema: listInputSchema,
    handler: listHandler,
  };

  // ---- query_repair_detail ----
  const detailTool: ToolDefinition = {
    name: 'query_repair_detail',
    description:
      '查询某条报修工单的详细信息、流转活动日志及处理进度。id 取自 query_repairs 返回的 id 字段。',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: '报修工单 id 或工单编号（query_repairs 返回的 id / code 字段）。',
        },
      },
      additionalProperties: false,
      required: ['id'],
    },
    async handler(args, toolContext) {
      const id = stringArg(args, 'id').trim();
      if (id === '') return errorResult('请提供报修工单 id');

      return await runWithSession(toolContext.env, toolContext.credentials, async (context) => {
        const client = await connectRepair(context.session, identityOf(context));
        const detail = await client.fetchOrderDetailById(id);

        return render({
          success: true,
          order: formatOrder(detail),
          applicant: detail.applicant,
          phone: detail.phone,
          handler: detail.handler,
          handlerDepartment: detail.handlerDepartment,
          handleResult: detail.handleResult,
          currentNode: detail.currentNode,
          activityLogs: detail.logs.map((log) => ({
            time: log.timeMs === null ? null : formatChinaIso(log.timeMs),
            userName: log.userName,
            description: log.description,
          })),
          attachments: detail.attachments.map((attachment) => ({
            id: attachment.id,
            fileName: attachment.fileName,
            downloadUrl: attachment.downloadUrl,
            createTime:
              attachment.createTimeMs === null ? null : formatChinaIso(attachment.createTimeMs),
          })),
        });
      });
    },
  };

  // ---- submit_repair_order ----
  const submitTool: ToolDefinition = {
    name: 'submit_repair_order',
    description:
      '向学校报修平台提交报修工单（支持后勤报修、校园网络报修、一校通报修、业务系统报修四大类）。' +
      '【重要·后勤必有图】：后勤报修（宿舍水电、门窗家具、生活公共设施等）必须附带现场故障照片！' +
      '服务端没有本地文件，请把用户发来的照片以 imageBase64（图片字节的 base64，可带 data URL 前缀）' +
      '或 imageUrl（可下载的图片地址）传入；没有图片时严禁提交，必须先向用户索取照片。' +
      '【重要·确认原则】：在正式提交前，必须向用户清晰呈现报修分类、故障地点、故障描述、预约时间等预览信息并征求用户明确同意确认。' +
      '首次调用时 confirmed 保持 false，用户确认后再传 confirmed=true 正式提交。',
    inputSchema: {
      type: 'object',
      properties: {
        catalog: {
          type: 'string',
          description:
            '报修分类名称，可选：“后勤报修”（宿舍生活公用设施）、“校园网络报修”（校园网/WiFi/网线）、“一校通报修”（校园卡/数字设备）、“业务系统报修”（教务/研究生等软件业务系统）。',
        },
        description: {
          type: 'string',
          description: '故障详细描述（必填，清晰阐明遇到的问题）。',
        },
        location: {
          type: 'string',
          description: '报修具体位置（如“东湖校区12栋502”、“第九教学楼201教室”等）。',
        },
        title: {
          type: 'string',
          description: '工单简要标题（可选，不填将自动生成，如“某某的后勤维修服务”）。',
        },
        imageBase64: {
          type: 'string',
          description:
            '现场故障照片的 base64 内容（可带 data:image/png;base64, 前缀；上限 6MB）。' +
            '后勤报修严格必填；用户在当前对话里发来照片时请把图片字节转成 base64 传入。',
        },
        imageUrl: {
          type: 'string',
          description:
            '现场故障照片的可访问地址（http/https，服务端会代下载后上传，上限 6MB）。' +
            '与 imageBase64 二选一；两个都传则各上传一张。',
        },
        imageName: {
          type: 'string',
          description: '可选：上传时使用的文件名（默认按时间生成，并按内容类型补扩展名）。',
        },
        appointment_date: {
          type: 'string',
          description: '期望预约维修日期，格式为 YYYY/MM/DD 或 YYYY-MM-DD（可选，默认为当天）。',
        },
        appointment_time: {
          type: 'string',
          description:
            '期望预约维修时间段（如“8_9”、“9_10”、“14_15”等，或“上午”、“下午”，可选）。',
        },
        phone: {
          type: 'string',
          description: '联系电话（可选，默认使用学号绑定的手机号）。',
        },
        confirmed: {
          type: 'boolean',
          description:
            '用户是否已明确同意并确认提交表单。默认为 false。' +
            '首次整理调用请保持 false，工具将返回待确认的表单预览；待用户明确确认后，再将 confirmed 设为 true 真正完成投递。',
          default: false,
        },
      },
      additionalProperties: false,
      required: ['catalog', 'description'],
    },
    async handler(args, toolContext) {
      const catalogInput = stringArg(args, 'catalog').trim();
      const description = stringArg(args, 'description').trim();
      if (description === '') return errorResult('请提供故障详细描述');

      const location = stringArg(args, 'location').trim();
      const userTitle = stringArg(args, 'title').trim();
      const phone = stringArg(args, 'phone').trim();
      const appointmentDate = stringArg(args, 'appointment_date').trim();
      const appointmentTime = stringArg(args, 'appointment_time').trim();
      const confirmed = args['confirmed'] === true;

      const catalog = resolveRepairCatalog(catalogInput === '' ? '后勤报修' : catalogInput);
      const isLogistics = catalog.title.includes('后勤');

      // 图片先落地成字节（Dart 在这一步校验本地文件是否存在）
      const images = await collectImages(args);
      if (isLogistics && images.length === 0) {
        return errorResult(
          '【后勤报修严格要求提供现场图片】：后勤报修系统要求必须上传现场故障照片！' +
            '请引导用户发送故障照片，并把图片以 imageBase64（或 imageUrl）传入后再提交。',
        );
      }

      const resolvedDate =
        appointmentDate === '' ? todayInChina() : appointmentDate.replace(/-/g, '/');

      return await runWithSession(toolContext.env, toolContext.credentials, async (context) => {
        const realName = context.identity?.realName ?? '';
        const resolvedTitle =
          userTitle !== ''
            ? userTitle
            : `${realName === '' ? '用户' : realName}的${catalog.title}`;

        // 未确认：只回预览，不碰报修平台
        if (!confirmed) {
          return render({
            success: true,
            needConfirmation: true,
            preview: {
              catalog: catalog.title,
              department: catalog.department,
              title: resolvedTitle,
              location: location !== '' ? location : '(未特别指定)',
              description,
              appointmentDate: resolvedDate,
              appointmentTime: appointmentTime !== '' ? appointmentTime : '默认维修时段',
              phone: phone !== '' ? phone : '(使用学号绑定手机号)',
              hasImage: images.length > 0,
              imageCount: images.length,
              imageNames: images.map((image) => image.fileName),
            },
            message:
              '报修工单已整理就绪。请向用户展示上述预览信息（包括报修分类、故障地点、问题描述、预约时间及图片）。' +
              '经用户明确确认同意后，将 confirmed 设为 true 再次调用以正式提交。',
          });
        }

        const client = await connectRepair(context.session, identityOf(context));
        const form = await client.loadForm(catalog);

        // 上传附件（字段名取自表单里的上传控件）
        let uploadedCount = 0;
        const uploadField = form.fields.find((field) => isUploadField(field));
        if (uploadField !== undefined) {
          for (const image of images) {
            await client.uploadAttachment(form, uploadField.name, image);
            uploadedCount += 1;
          }
        }

        const values = await collectSubmitValues(client, form, {
          location,
          description,
          title: resolvedTitle,
          phone,
          appointmentDate: resolvedDate,
          appointmentTime,
          uploadedCount,
        });
        await client.submit(form, values, false);

        return render({
          success: true,
          message: '报修工单已成功提交！',
          catalog: catalog.title,
          title: resolvedTitle,
          instanceId: form.instanceId,
          uploadedImages: uploadedCount,
        });
      });
    },
  };

  // ---- cancel_repair_order ----
  const cancelTool: ToolDefinition = {
    name: 'cancel_repair_order',
    description:
      '取消指定的报修工单。安全原则：必须先以 confirmed=false 调用此工具向用户展示待取消工单详情并征得用户明确同意；' +
      '获得用户同意后，再以 confirmed=true 调用此工具正式执行取消。',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: {
          type: 'string',
          description: '待取消的报修工单编号或工单ID（例如“WX202609230001”或数字ID）。',
        },
        confirmed: {
          type: 'boolean',
          description: '用户是否已明确同意取消此工单。首次调用传 false，待用户明确确认后再传 true。',
          default: false,
        },
      },
      additionalProperties: false,
      required: ['order_id'],
    },
    async handler(args, toolContext) {
      const orderId = stringArg(args, 'order_id').trim();
      if (orderId === '') {
        return errorResult('参数错误: 请提供需要取消的工单编号 (order_id)');
      }
      const confirmed = args['confirmed'] === true;

      return await runWithSession(toolContext.env, toolContext.credentials, async (context) => {
        const client = await connectRepair(context.session, identityOf(context));
        const order = await client.fetchOrderDetailById(orderId);

        // 当前节点没有「取消」动作就不能取消（派工处理之后就没了）
        if (!canCancelRepairOrder(order)) {
          const label = order.code !== '' ? order.code : orderId;
          const statusLabel = order.status !== '' ? order.status : '当前状态';
          return errorResult(
            `工单 ${label} (${statusLabel}) 当前不支持取消。只有在派工处理前的工单方可取消。`,
          );
        }

        if (!confirmed) {
          return render({
            status: 'confirmation_required',
            requires_confirmation: true,
            message:
              '取消工单是不可逆操作。请向用户展示以下待取消工单的信息，并询问是否确认取消。' +
              '在用户明确确认后，再次调用此工具并将 confirmed 设为 true。',
            order: formatOrder(order),
          });
        }

        const success = await client.cancelOrder(order);
        if (!success) return errorResult('取消工单失败，平台未返回成功状态。');
        return render({
          success: true,
          message: `工单 ${order.code !== '' ? order.code : orderId} 已成功取消。`,
          order: formatOrder(order),
        });
      });
    },
  };

  return [listTool, listAliasTool, detailTool, submitTool, cancelTool];
}

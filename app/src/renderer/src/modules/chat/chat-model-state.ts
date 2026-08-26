import type {
  ChatRoutingStrategy,
  ModelSummary,
  RuntimeStatus
} from '@ariadne/protocol/public';
import { formatRuntimeAvailability } from '@renderer/core/runtime/runtime-labels';

export type ChatModelStateKind =
  | 'runtime-unavailable'
  | 'plan-unavailable'
  | 'unconfigured'
  | 'checking'
  | 'unavailable'
  | 'agent-incompatible'
  | 'privacy-unavailable'
  | 'ready';

export interface ChatModelStateInput {
  readonly runtimeAvailability: RuntimeStatus['availability'];
  readonly planModeAvailable: boolean;
  readonly planModeEnabled: boolean;
  readonly routingStrategy: ChatRoutingStrategy;
  readonly models: readonly ModelSummary[];
}

export interface ChatModelState {
  readonly kind: ChatModelStateKind;
  readonly statusTone: 'danger' | 'success' | 'warning';
  readonly statusLabel: string;
  readonly composerPlaceholder: string;
  readonly emptyTitle: string;
  readonly emptyDescription: string;
  readonly readyModels: readonly ModelSummary[];
  readonly eligibleModels: readonly ModelSummary[];
  readonly canChat: boolean;
}

/**
 * Separates model configuration, health, routing and Agent eligibility. A
 * configured model that is still checking or unavailable must never collapse
 * back into the unconfigured state.
 */
export function deriveChatModelState(input: ChatModelStateInput): ChatModelState {
  const readyModels = input.models.filter((model) => model.availability === 'ready');
  const modeConfiguredModels = input.planModeEnabled
    ? input.models.filter((model) => model.supportsAgent)
    : input.models;
  const routeConfiguredModels = input.routingStrategy === 'privacy-first'
    ? modeConfiguredModels.filter((model) => model.location === 'local')
    : modeConfiguredModels;
  const eligibleModels = routeConfiguredModels.filter((model) => model.availability === 'ready');

  let kind: ChatModelStateKind;
  if (input.runtimeAvailability !== 'ready') kind = 'runtime-unavailable';
  else if (input.planModeEnabled && !input.planModeAvailable) kind = 'plan-unavailable';
  else if (input.models.length === 0) kind = 'unconfigured';
  else if (input.planModeEnabled && modeConfiguredModels.length === 0) kind = 'agent-incompatible';
  else if (input.routingStrategy === 'privacy-first' && routeConfiguredModels.length === 0) {
    kind = 'privacy-unavailable';
  } else if (eligibleModels.length > 0) kind = 'ready';
  else if (routeConfiguredModels.some((model) => model.availability === 'checking')) kind = 'checking';
  else kind = 'unavailable';

  return {
    kind,
    ...presentation(kind, input.runtimeAvailability, input.planModeEnabled),
    readyModels,
    eligibleModels,
    canChat: kind === 'ready'
  };
}

function presentation(
  kind: ChatModelStateKind,
  runtimeAvailability: RuntimeStatus['availability'],
  planModeEnabled: boolean
): Pick<
  ChatModelState,
  'statusTone' | 'statusLabel' | 'composerPlaceholder' | 'emptyTitle' | 'emptyDescription'
> {
  switch (kind) {
    case 'runtime-unavailable':
      return {
        statusTone: 'danger',
        statusLabel: formatRuntimeAvailability(runtimeAvailability),
        composerPlaceholder: 'Runtime 当前不可用',
        emptyTitle: 'Runtime 当前不可用',
        emptyDescription: '等待 Runtime 恢复后即可继续使用已配置模型。'
      };
    case 'plan-unavailable':
      return {
        statusTone: 'warning',
        statusLabel: '计划模式不可用',
        composerPlaceholder: '当前 Runtime 构建不支持计划模式，请完整重启 Ariadne',
        emptyTitle: '计划模式不可用',
        emptyDescription: '当前 Runtime 构建不支持计划模式，请完整重启 Ariadne。'
      };
    case 'unconfigured':
      return {
        statusTone: 'warning',
        statusLabel: '未配置模型',
        composerPlaceholder: '请先在设置中配置 API Key 或本地模型目录',
        emptyTitle: '先配置可用模型',
        emptyDescription: '打开设置，填写 OpenAI、DeepSeek、Kimi 或 Anthropic API Key，也可以添加本地模型目录。'
      };
    case 'checking':
      return {
        statusTone: 'warning',
        statusLabel: '正在检查模型',
        composerPlaceholder: '正在检查已配置模型，请稍候',
        emptyTitle: '正在检查模型',
        emptyDescription: 'Runtime 正在验证已配置模型的连接与能力。'
      };
    case 'unavailable':
      return {
        statusTone: 'warning',
        statusLabel: '模型不可用',
        composerPlaceholder: '已配置模型当前不可用，请在设置中检查模型状态',
        emptyTitle: '已配置模型暂不可用',
        emptyDescription: '打开设置查看模型检查结果，并确认模型地址、凭据或本地运行环境。'
      };
    case 'agent-incompatible':
      return {
        statusTone: 'warning',
        statusLabel: '模型不支持 Agent',
        composerPlaceholder: '已配置模型不支持 Agent 协议，请选择兼容模型',
        emptyTitle: '需要支持 Agent 的模型',
        emptyDescription: '计划模式只会使用明确支持 Agent 协议的可用模型。'
      };
    case 'privacy-unavailable':
      return {
        statusTone: 'warning',
        statusLabel: '无可用本地模型',
        composerPlaceholder: '隐私优先仅使用本地模型，请配置或启用可用本地模型',
        emptyTitle: '隐私优先需要本地模型',
        emptyDescription: '当前路由不会使用远程模型，请配置或启用可用本地模型。'
      };
    case 'ready':
      return {
        statusTone: 'success',
        statusLabel: '就绪',
        composerPlaceholder: planModeEnabled
          ? '描述需要规划的任务；计划模式只读分析'
          : '向 Ariadne 发送消息；按 Shift + Enter 换行',
        emptyTitle: '开始新会话',
        emptyDescription: '描述你的目标，AI 会直接开始处理；只有实际工具权限不足时，Ariadne 才会向你确认具体操作。'
      };
  }
}

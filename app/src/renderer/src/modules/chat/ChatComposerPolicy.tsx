import {
  Hand,
  Settings2,
  ShieldAlert,
  ShieldCheck
} from 'lucide-react';
import type {
  ChatRoutingStrategy,
  ModelInferenceOptions,
  ModelSummary
} from '@ariadne/protocol/public';
import type { AgentPermissionMode } from '@shared/contract';
import { type SelectMenuOption } from '@renderer/shared/ui/SelectMenu';

export const AUTO_MODEL_ID = '__auto__';

export const AUTO_ROUTING_PREFIX = `${AUTO_MODEL_ID}:`;

export const routingOptions: readonly SelectMenuOption<ChatRoutingStrategy>[] = [
  { value: 'local-first', label: '本地模型优先' },
  { value: 'cloud-first', label: '远程模型优先' },
  { value: 'privacy-first', label: '隐私优先', description: '仅使用本地模型' },
  { value: 'quality-first', label: '质量优先' }
];

export const permissionModeOptions: readonly SelectMenuOption<AgentPermissionMode>[] = [
  { value: 'request', label: '请求批准', description: 'AI 可开始处理，具体写入或运行操作由你批准', icon: <Hand size={16} /> },
  { value: 'risk-based', label: '替我审批', description: '普通文件编辑自动执行，命令和高风险操作再询问', icon: <ShieldCheck size={16} /> },
  { value: 'full-access', label: '完全访问权限', description: 'AI 请求的工具在设置范围内直接执行', icon: <ShieldAlert size={16} />, tone: 'warning' },
  { value: 'custom', label: '自定义 (settings.toml)', description: '使用 settings.toml 中定义的权限', icon: <Settings2 size={16} /> }
];

export function parseRoutingSelectionValue(value: string): ChatRoutingStrategy | null {
  if (!value.startsWith(AUTO_ROUTING_PREFIX)) return null;
  const strategy = value.slice(AUTO_ROUTING_PREFIX.length);
  return routingOptions.some((option) => option.value === strategy)
    ? strategy as ChatRoutingStrategy
    : null;
}

export function defaultInference(model: ModelSummary): ModelInferenceOptions {
  const reasoning = model.inference?.reasoning;
  if (!reasoning) return {};
  return {
    reasoningMode: reasoning.defaultMode,
    ...(reasoning.defaultEffort ? { reasoningEffort: reasoning.defaultEffort } : {})
  };
}

export function inferenceSupported(model: ModelSummary, inference: ModelInferenceOptions): boolean {
  const reasoning = model.inference?.reasoning;
  if (!reasoning) return !inference.reasoningMode && !inference.reasoningEffort;
  return Boolean(inference.reasoningMode && reasoning.modes.includes(inference.reasoningMode))
    && (!inference.reasoningEffort || reasoning.efforts.includes(inference.reasoningEffort));
}

export function reasoningModeLabel(value: 'off' | 'on' | 'auto' | 'pro'): string {
  return { off: '推理关闭', on: '推理开启', auto: '推理自动', pro: '推理 Pro' }[value];
}

export function reasoningEffortLabel(value: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'): string {
  return { none: '无', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' }[value];
}

export function modelCapabilityLabel(model: ModelSummary): string {
  if (model.supportsPlan) return 'Plan';
  if (model.supportsAgent) return 'Agent';
  if (model.supportsTextChat) return '仅文本';
  return model.qualificationState === 'testing' ? '检测中' : '未通过资格检测';
}

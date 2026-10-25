import {
  Hand,
  Settings2,
  ShieldAlert,
  ShieldCheck
} from 'lucide-react';
import type {
  ModelInferenceOptions,
  ModelSummary
} from '@ariadne/protocol/public';
import type { AgentPermissionMode } from '@shared/contract';
import { type SelectMenuOption } from '@renderer/shared/ui/SelectMenu';

export const permissionModeOptions: readonly SelectMenuOption<AgentPermissionMode>[] = [
  { value: 'request', label: '请求批准', description: 'AI 可开始处理，具体写入或运行操作由你批准', icon: <Hand size={16} /> },
  { value: 'risk-based', label: '替我审批', description: '普通文件编辑自动执行，命令和高风险操作再询问', icon: <ShieldCheck size={16} /> },
  { value: 'full-access', label: '完全访问权限', description: 'AI 请求的工具在设置范围内直接执行', icon: <ShieldAlert size={16} />, tone: 'warning' },
  { value: 'custom', label: '自定义 (settings.toml)', description: '使用 settings.toml 中定义的权限', icon: <Settings2 size={16} /> }
];

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

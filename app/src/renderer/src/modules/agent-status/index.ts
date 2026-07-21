import type { FeatureModuleDefinition } from '@renderer/core/modules/module-contract';
import { MODULE_IDS } from '@renderer/core/modules/module-ids';
import { AgentStatusPanel } from './AgentStatusPanel';

export const agentStatusModule: FeatureModuleDefinition = {
  id: MODULE_IDS.agentStatus,
  name: 'Agent 状态',
  description: '查看当前任务、上下文和运行状态。',
  icon: 'bot',
  component: AgentStatusPanel,
  defaultOpen: true,
  defaultPlacement: { direction: 'right', referenceModuleId: MODULE_IDS.chat, initialWidth: 320 },
  requiredCapabilities: []
};

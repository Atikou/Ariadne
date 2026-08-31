import { moduleId, type FeatureModuleDefinition } from '@renderer/core/modules/module-contract';
import { AgentStatusPanel } from './AgentStatusPanel';

export const agentStatusModule: FeatureModuleDefinition = {
  id: moduleId('agent.status'),
  name: 'Agent 状态',
  description: '查看当前任务、上下文和运行状态。',
  icon: 'bot',
  component: AgentStatusPanel,
  consumes: ['runtime'],
  navigation: { id: 'agent', label: 'Agent', icon: 'bot', order: 20, position: 'primary' },
  defaultOpen: true,
  defaultActivationOrder: 20,
  defaultPlacement: { direction: 'right', referenceModuleId: moduleId('chat.main'), initialWidth: 320 },
  layoutConstraints: { minimumWidth: 240 },
  requiredCapabilities: []
};

import { moduleId, type FeatureModuleDefinition } from '@renderer/core/modules/module-contract';
import { AgentPlanPanel } from './AgentPlanPanel';

export const agentPlanModule: FeatureModuleDefinition = {
  id: moduleId('agent.plan'),
  name: '执行计划',
  description: '查看当前任务的步骤和进度。',
  icon: 'list',
  component: AgentPlanPanel,
  consumes: ['runtime'],
  navigation: { id: 'agent', label: 'Agent', icon: 'bot', order: 20, position: 'primary' },
  defaultOpen: true,
  defaultPlacement: { direction: 'within', referenceModuleId: moduleId('agent.status') },
  layoutConstraints: { minimumWidth: 240 },
  requiredCapabilities: []
};

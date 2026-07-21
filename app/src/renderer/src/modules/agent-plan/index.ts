import type { FeatureModuleDefinition } from '@renderer/core/modules/module-contract';
import { MODULE_IDS } from '@renderer/core/modules/module-ids';
import { AgentPlanPanel } from './AgentPlanPanel';

export const agentPlanModule: FeatureModuleDefinition = {
  id: MODULE_IDS.agentPlan,
  name: '执行计划',
  description: '查看当前任务的步骤和进度。',
  icon: 'list',
  component: AgentPlanPanel,
  defaultOpen: true,
  defaultPlacement: { direction: 'within', referenceModuleId: MODULE_IDS.agentStatus },
  requiredCapabilities: []
};

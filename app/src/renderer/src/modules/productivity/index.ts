import type { FeatureModuleDefinition } from '@renderer/core/modules/module-contract';
import { MODULE_IDS } from '@renderer/core/modules/module-ids';
import { ProductivityPanel } from './ProductivityPanel';

export const productivityModule: FeatureModuleDefinition = {
  id: MODULE_IDS.productivity,
  name: '目标与工作流',
  description: '管理同一会话的 Goal、Todo、Workflow 与 Schedule。',
  icon: 'list',
  component: ProductivityPanel,
  defaultOpen: false,
  defaultPlacement: { direction: 'within', referenceModuleId: MODULE_IDS.agentPlan },
  layoutConstraints: { minimumWidth: 300 },
  requiredCapabilities: []
};

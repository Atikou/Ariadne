import { moduleId, type FeatureModuleDefinition } from '@renderer/core/modules/module-contract';
import { ProductivityPanel } from './ProductivityPanel';

export const productivityModule: FeatureModuleDefinition = {
  id: moduleId('productivity.control'),
  name: '目标与工作流',
  description: '管理同一会话的 Goal、Todo、Workflow 与 Schedule。',
  icon: 'list',
  component: ProductivityPanel,
  defaultOpen: false,
  defaultPlacement: { direction: 'within', referenceModuleId: moduleId('agent.plan') },
  layoutConstraints: { minimumWidth: 300 },
  requiredCapabilities: []
};

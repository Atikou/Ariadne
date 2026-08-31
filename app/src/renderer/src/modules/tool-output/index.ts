import { moduleId, type FeatureModuleDefinition } from '@renderer/core/modules/module-contract';
import { ToolOutputPanel } from './ToolOutputPanel';

export const toolOutputModule: FeatureModuleDefinition = {
  id: moduleId('tools.output'),
  name: '工具输出',
  description: '查看工具调用结果和结构化输出。',
  icon: 'tool',
  component: ToolOutputPanel,
  navigation: { id: 'tools', label: '工具输出', icon: 'tool', order: 40, position: 'primary' },
  defaultOpen: true,
  defaultActivationOrder: 10,
  defaultPlacement: { edge: { position: 'bottom', groupId: 'bottom-tools', initialSize: 230, collapsedSize: 44, collapsed: false } },
  layoutConstraints: { minimumWidth: 320 },
  requiredCapabilities: []
};

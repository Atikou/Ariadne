import type { FeatureModuleDefinition } from '@renderer/core/modules/module-contract';
import { MODULE_IDS } from '@renderer/core/modules/module-ids';
import { ToolOutputPanel } from './ToolOutputPanel';

export const toolOutputModule: FeatureModuleDefinition = {
  id: MODULE_IDS.toolOutput,
  name: '工具输出',
  description: '查看工具调用结果和结构化输出。',
  icon: 'tool',
  component: ToolOutputPanel,
  defaultOpen: true,
  defaultPlacement: { edge: { position: 'bottom', groupId: 'bottom-tools', initialSize: 230, collapsedSize: 44, collapsed: false } },
  layoutConstraints: { minimumWidth: 320 },
  requiredCapabilities: []
};

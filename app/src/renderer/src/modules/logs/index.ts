import type { FeatureModuleDefinition } from '@renderer/core/modules/module-contract';
import { MODULE_IDS } from '@renderer/core/modules/module-ids';
import { LogsPanel } from './LogsPanel';

export const logsModule: FeatureModuleDefinition = {
  id: MODULE_IDS.logs,
  name: '日志',
  description: '查看任务和 Runtime 事件日志。',
  icon: 'activity',
  component: LogsPanel,
  defaultOpen: true,
  defaultPlacement: { edge: { position: 'bottom', groupId: 'bottom-tools', initialSize: 230, collapsedSize: 44, collapsed: false } },
  requiredCapabilities: []
};

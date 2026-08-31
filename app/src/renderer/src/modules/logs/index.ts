import { moduleId, type FeatureModuleDefinition } from '@renderer/core/modules/module-contract';
import { LogsPanel } from './LogsPanel';

export const logsModule: FeatureModuleDefinition = {
  id: moduleId('logs'),
  name: '日志',
  description: '查看任务和 Runtime 事件日志。',
  icon: 'activity',
  component: LogsPanel,
  consumes: ['diagnostics'],
  defaultOpen: true,
  defaultPlacement: { edge: { position: 'bottom', groupId: 'bottom-tools', initialSize: 230, collapsedSize: 44, collapsed: false } },
  layoutConstraints: { minimumWidth: 320 },
  requiredCapabilities: []
};

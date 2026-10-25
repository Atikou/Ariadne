import { moduleId, type FeatureModuleDefinition } from '@renderer/core/modules/module-contract';
import { TaskCenterPanel } from './TaskCenterPanel';

export const taskCenterModule: FeatureModuleDefinition = {
  id: moduleId('tasks.center'), name: '任务中心', description: '汇总各会话任务，查看来源、关联与结果。',
  icon: 'list', component: TaskCenterPanel,
  consumes: ['tasks', 'sessions', 'runs', 'decisions', 'messages', 'events', 'conversationNavigation', 'preferences'],
  navigation: { id: 'tasks', label: '任务', icon: 'list', order: 25, position: 'primary' },
  defaultOpen: false, defaultPlacement: { direction: 'within', referenceModuleId: moduleId('agent.status') },
  layoutConstraints: { minimumWidth: 280 }, requiredCapabilities: []
};

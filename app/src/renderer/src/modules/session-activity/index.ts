import { moduleId, type FeatureModuleDefinition } from '@renderer/core/modules/module-contract';
import { SessionActivityPanel } from './SessionActivityPanel';

export const sessionActivityModule: FeatureModuleDefinition = {
  id: moduleId('session.activity'),
  name: '会话活动',
  description: '查看每轮处理的工具调用图、系统事件与文件变更。',
  icon: 'activity',
  component: SessionActivityPanel,
  consumes: ['runs', 'sessions'],
  defaultOpen: false,
  defaultPlacement: {
    direction: 'within',
    referenceModuleId: moduleId('chat.main')
  },
  layoutConstraints: { minimumWidth: 760 },
  requiredCapabilities: []
};

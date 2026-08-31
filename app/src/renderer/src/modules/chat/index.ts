import { moduleId, type FeatureModuleDefinition } from '@renderer/core/modules/module-contract';
import { ChatPanel } from './ChatPanel';

export const chatModule: FeatureModuleDefinition = {
  id: moduleId('chat.main'),
  name: '对话',
  description: '与 Agent 交互的主工作区。',
  icon: 'message',
  component: ChatPanel,
  consumes: [
    'agentSettings', 'clipboard', 'conversationNavigation', 'events',
    'messages', 'runs', 'runtime', 'sessions', 'speech', 'system'
  ],
  navigation: { id: 'chat', label: '对话', icon: 'message', order: 10, position: 'primary' },
  defaultOpen: true,
  defaultActivationOrder: 30,
  defaultPlacement: {},
  layoutConstraints: { minimumWidth: 620 },
  requiredCapabilities: []
};

import type { FeatureModuleDefinition } from '@renderer/core/modules/module-contract';
import { MODULE_IDS } from '@renderer/core/modules/module-ids';
import { ConversationsPanel } from './ConversationsPanel';

export const conversationsModule: FeatureModuleDefinition = {
  id: MODULE_IDS.conversations,
  name: '会话',
  description: '浏览和切换会话。',
  icon: 'message',
  component: ConversationsPanel,
  defaultOpen: true,
  defaultPlacement: { direction: 'left', referenceModuleId: MODULE_IDS.chat, initialWidth: 260 },
  requiredCapabilities: []
};

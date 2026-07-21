import type { FeatureModuleDefinition } from '@renderer/core/modules/module-contract';
import { MODULE_IDS } from '@renderer/core/modules/module-ids';
import { ChatPanel } from './ChatPanel';

export const chatModule: FeatureModuleDefinition = {
  id: MODULE_IDS.chat,
  name: 'Chat',
  description: '与 Agent 交互的主工作区。',
  icon: 'message',
  component: ChatPanel,
  defaultOpen: true,
  defaultPlacement: {},
  requiredCapabilities: []
};

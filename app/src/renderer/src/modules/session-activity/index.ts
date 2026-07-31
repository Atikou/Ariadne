import type { FeatureModuleDefinition } from '@renderer/core/modules/module-contract';
import { MODULE_IDS } from '@renderer/core/modules/module-ids';
import { SessionActivityPanel } from './SessionActivityPanel';

export const sessionActivityModule: FeatureModuleDefinition = {
  id: MODULE_IDS.sessionActivity,
  name: '会话活动',
  description: '查看每轮处理的工具调用图、系统事件与文件变更。',
  icon: 'activity',
  component: SessionActivityPanel,
  defaultOpen: false,
  defaultPlacement: {
    direction: 'within',
    referenceModuleId: MODULE_IDS.chat
  },
  layoutConstraints: { minimumWidth: 760 },
  requiredCapabilities: []
};

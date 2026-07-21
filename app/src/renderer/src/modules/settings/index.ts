import type { FeatureModuleDefinition } from '@renderer/core/modules/module-contract';
import { MODULE_IDS } from '@renderer/core/modules/module-ids';
import { SettingsPanel } from './SettingsPanel';

export const settingsModule: FeatureModuleDefinition = {
  id: MODULE_IDS.settings, name: '设置', description: '主题、后台行为和桌面偏好。', icon: 'settings', component: SettingsPanel,
  defaultOpen: false,
  defaultPlacement: { direction: 'right', referenceModuleId: MODULE_IDS.chat, initialWidth: 420 },
  requiredCapabilities: []
};

import { moduleId, type FeatureModuleDefinition } from '@renderer/core/modules/module-contract';
import { SettingsDialog } from './SettingsDialog';
import { SettingsPanel } from './SettingsPanel';

export const settingsModule: FeatureModuleDefinition = {
  id: moduleId('settings'), name: '设置', description: '模型、API Key、主题和桌面偏好。', icon: 'settings', component: SettingsPanel,
  consumes: [
    'agentSettings', 'applicationProfile', 'conversationNavigation', 'events', 'preferences',
    'diagnostics', 'models', 'sessions', 'speech', 'system'
  ],
  presentation: { kind: 'dialog', component: SettingsDialog },
  navigation: { id: 'settings', label: '设置', icon: 'settings', order: 100, position: 'footer' },
  defaultOpen: false,
  defaultPlacement: { direction: 'right', referenceModuleId: moduleId('chat.main'), initialWidth: 420 },
  layoutConstraints: { minimumWidth: 340 },
  requiredCapabilities: []
};

import { moduleId, type FeatureModuleDefinition } from '@renderer/core/modules/module-contract';
import { TerminalPanel } from './TerminalPanel';

export const terminalModule: FeatureModuleDefinition = {
  id: moduleId('terminal'), name: '终端', description: 'PowerShell 与 CMD 集成终端。', icon: 'terminal', component: TerminalPanel,
  consumes: ['conversationNavigation', 'terminal'],
  defaultOpen: true, defaultPlacement: { edge: { position: 'bottom', groupId: 'bottom-tools', initialSize: 230, collapsedSize: 44, collapsed: false } },
  layoutConstraints: { minimumWidth: 320 }, requiredCapabilities: []
};

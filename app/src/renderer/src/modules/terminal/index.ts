import type { FeatureModuleDefinition } from '@renderer/core/modules/module-contract';
import { MODULE_IDS } from '@renderer/core/modules/module-ids';
import { TerminalPanel } from './TerminalPanel';

export const terminalModule: FeatureModuleDefinition = {
  id: MODULE_IDS.terminal, name: '终端', description: 'PowerShell 与 CMD 集成终端。', icon: 'terminal', component: TerminalPanel,
  defaultOpen: true, defaultPlacement: { edge: { position: 'bottom', groupId: 'bottom-tools', initialSize: 230, collapsedSize: 44, collapsed: false } }, requiredCapabilities: []
};

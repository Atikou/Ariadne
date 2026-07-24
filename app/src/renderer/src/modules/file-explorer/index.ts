import type { FeatureModuleDefinition } from '@renderer/core/modules/module-contract';
import { MODULE_IDS } from '@renderer/core/modules/module-ids';
import { FileExplorerPanel } from './FileExplorerPanel';

export const fileExplorerModule: FeatureModuleDefinition = {
  id: MODULE_IDS.files, name: '文件', description: '浏览当前工作区文件。', icon: 'file', component: FileExplorerPanel,
  defaultOpen: false,
  defaultPlacement: { direction: 'left', referenceModuleId: MODULE_IDS.chat, initialWidth: 270 },
  layoutConstraints: { minimumWidth: 220 },
  requiredCapabilities: []
};

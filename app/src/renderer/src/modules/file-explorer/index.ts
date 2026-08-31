import { moduleId, type FeatureModuleDefinition } from '@renderer/core/modules/module-contract';
import { FileExplorerPanel } from './FileExplorerPanel';

export const fileExplorerModule: FeatureModuleDefinition = {
  id: moduleId('files.explorer'), name: '文件', description: '浏览当前工作区文件。', icon: 'file', component: FileExplorerPanel,
  consumes: ['conversationNavigation', 'workspace'],
  navigation: { id: 'files', label: '文件', icon: 'file', order: 30, position: 'primary' },
  defaultOpen: false,
  defaultPlacement: { direction: 'left', referenceModuleId: moduleId('chat.main'), initialWidth: 270 },
  layoutConstraints: { minimumWidth: 220 },
  requiredCapabilities: []
};

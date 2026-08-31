import { moduleId, type FeatureModuleDefinition } from '@renderer/core/modules/module-contract';
import { PermissionsPanel } from './PermissionsPanel';

export const permissionsModule: FeatureModuleDefinition = {
  id: moduleId('permissions'),
  name: '权限',
  description: '处理文件、系统能力和工具权限请求。',
  icon: 'shield',
  component: PermissionsPanel,
  consumes: ['runtime'],
  navigation: { id: 'permissions', label: '权限', icon: 'shield', order: 50, position: 'primary' },
  defaultOpen: false,
  defaultPlacement: { direction: 'right', referenceModuleId: moduleId('chat.main'), initialWidth: 340 },
  layoutConstraints: { minimumWidth: 280 },
  requiredCapabilities: []
};

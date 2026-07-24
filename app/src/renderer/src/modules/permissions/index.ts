import type { FeatureModuleDefinition } from '@renderer/core/modules/module-contract';
import { MODULE_IDS } from '@renderer/core/modules/module-ids';
import { PermissionsPanel } from './PermissionsPanel';

export const permissionsModule: FeatureModuleDefinition = {
  id: MODULE_IDS.permissions,
  name: '权限',
  description: '处理文件、系统能力和工具权限请求。',
  icon: 'shield',
  component: PermissionsPanel,
  defaultOpen: false,
  defaultPlacement: { direction: 'right', referenceModuleId: MODULE_IDS.chat, initialWidth: 340 },
  layoutConstraints: { minimumWidth: 280 },
  requiredCapabilities: []
};

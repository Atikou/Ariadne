import { moduleId, type FeatureModuleDefinition } from '@renderer/core/modules/module-contract';
import { RuntimeHealthPanel } from './RuntimeHealthPanel';

export const runtimeHealthModule: FeatureModuleDefinition = {
  id: moduleId('runtime.health'),
  name: 'Runtime 健康',
  description: '只读显示 Runtime 与 Projection 健康状态。',
  icon: 'activity',
  component: RuntimeHealthPanel,
  consumes: ['applicationProfile', 'diagnostics'],
  defaultOpen: false,
  defaultPlacement: {
    edge: {
      position: 'bottom',
      groupId: 'bottom-tools',
      initialSize: 190,
      collapsedSize: 44,
      collapsed: true
    }
  },
  layoutConstraints: { minimumWidth: 280 },
  requiredCapabilities: []
};

import { moduleId, type FeatureModuleDefinition } from '@renderer/core/modules/module-contract';
import { MemoryPanel } from './MemoryPanel';

export const memoryModule: FeatureModuleDefinition = {
  id: moduleId('memory.manage'), name: '长期记忆', description: '查看、编辑和审核长期记忆，检查实际召回结果。', icon: 'list',
  component: MemoryPanel, consumes: ['memory', 'sessions'], defaultOpen: false,
  defaultPlacement: { direction: 'within', referenceModuleId: moduleId('productivity.control') },
  layoutConstraints: { minimumWidth: 300 }, requiredCapabilities: []
};

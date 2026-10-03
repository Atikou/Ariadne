import { moduleId, type FeatureModuleDefinition } from '@renderer/core/modules/module-contract';
import { VisualReviewPanel } from './VisualReviewPanel';

export const visualReviewModule: FeatureModuleDefinition = {
  id: moduleId('review.visual'),
  name: '可视化审查',
  description: '通过完整时序图审查会话中的参与者、文件变更、验证证据与引用上下文。',
  icon: 'review',
  component: VisualReviewPanel,
  consumes: ['messages', 'runs', 'sessions', 'toolResults'],
  navigation: { id: 'visual-review', label: '可视化审查', icon: 'review', order: 35, position: 'primary' },
  defaultOpen: false,
  defaultPlacement: {
    direction: 'within',
    referenceModuleId: moduleId('chat.main')
  },
  layoutConstraints: { minimumWidth: 780 },
  requiredCapabilities: []
};

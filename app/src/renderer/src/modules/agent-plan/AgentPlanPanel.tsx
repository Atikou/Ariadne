import { Check, Circle, LoaderCircle } from 'lucide-react';
import type { FeaturePanelProps } from '@renderer/core/modules/module-contract';

export function AgentPlanPanel({ moduleId }: FeaturePanelProps): React.JSX.Element {
  return <section className="simple-module-panel" aria-labelledby={`${moduleId}-title`}><header className="module-content-header"><div><span>EXECUTION PLAN</span><h1 id={`${moduleId}-title`}>执行计划</h1></div></header><div className="plan-list"><article className="is-complete"><Check size={15} /><div><strong>架构与安全边界</strong><p>Main、Preload、Renderer 契约已经固定。</p></div></article><article className="is-running"><LoaderCircle className="is-spinning" size={15} /><div><strong>模块化工作区</strong><p>实现 Chat、会话和 Agent 状态模块。</p></div></article><article><Circle size={15} /><div><strong>交互与视觉验证</strong><p>检查主题、响应式布局和最终截图。</p></div></article></div></section>;
}

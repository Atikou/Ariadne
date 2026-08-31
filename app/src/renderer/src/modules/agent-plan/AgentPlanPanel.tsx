import { Check } from 'lucide-react';
import { useFeatureSnapshot } from '@renderer/core/runtime/features/feature-snapshot-store';
import type { FeaturePanelProps } from '@renderer/core/modules/module-contract';
import { PlanContractView } from './PlanContractView';

export function AgentPlanPanel({ moduleId, services }: FeaturePanelProps): React.JSX.Element {
  const decisions = useFeatureSnapshot(services.decisions.view);
  return <section className="simple-module-panel" aria-labelledby={`${moduleId}-title`}>
    <header className="module-content-header"><div><span>执行计划</span><h1 id={`${moduleId}-title`}>计划确认</h1></div></header>
    {decisions.planHandoffs.map((handoff) => <article key={handoff.handoffId} className="plan-handoff-card">
      <h2>{handoff.title}</h2>
      {handoff.plan
        ? <PlanContractView plan={handoff.plan} />
        : <div>
          <p>{handoff.summary}</p>
          <p><small>影响：{handoff.impactSummary}</small></p>
          <ol>{handoff.steps.map((step) => <li key={step.stepId}>
            <strong>{step.title}</strong>{step.detail && <p>{step.detail}</p>}
          </li>)}</ol>
        </div>}
      {!handoff.actionAvailable && <p className="module-empty-state">当前 v3 决策写入通道尚未启用；操作已安全锁定。</p>}
      {handoff.status === 'pending' && handoff.actionAvailable && <div className="rewrite-action-row"><button type="button" className="rewrite-cancel-button" onClick={() => void services.decisions.respondToPlan(handoff, 'reject')}>拒绝</button><button type="button" className="rewrite-send-button" disabled={handoff.plan !== null && !isApprovable(handoff.plan)} onClick={() => void services.decisions.respondToPlan(handoff, 'approve')}><Check size={13} /> 批准计划</button></div>}
    </article>)}
    {decisions.planHandoffs.length === 0 && <p className="module-empty-state">暂无需要确认的计划。</p>}
  </section>;
}

function isApprovable(plan: Parameters<typeof PlanContractView>[0]['plan']): boolean {
  return plan.planState === 'ready_for_confirmation'
    && plan.completeness === 'complete'
    && !plan.qualityIssues.some((issue) => issue.severity === 'critical');
}

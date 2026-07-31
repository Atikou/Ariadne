import { Check, RotateCw } from 'lucide-react';
import { useRuntimeSnapshot } from '@renderer/core/runtime/runtime-store';
import type { FeaturePanelProps } from '@renderer/core/modules/module-contract';
import { PlanContractView } from './PlanContractView';

export function AgentPlanPanel({ moduleId, services }: FeaturePanelProps): React.JSX.Element {
  const runtime = useRuntimeSnapshot(services.runtime);
  const retryableRunIds = new Set(runtime.runs
    .filter((run) => run.status === 'waiting_plan_handoff')
    .map((run) => run.runId));
  return <section className="simple-module-panel" aria-labelledby={`${moduleId}-title`}>
    <header className="module-content-header"><div><span>执行计划</span><h1 id={`${moduleId}-title`}>计划确认</h1></div></header>
    {runtime.planHandoffs.map((handoff) => <article key={handoff.handoffId} className="plan-handoff-card">
      <h2>{handoff.plan.title}</h2>
      <PlanContractView plan={handoff.plan} />
      {handoff.status === 'pending' && <div className="rewrite-action-row"><button type="button" className="rewrite-cancel-button" onClick={() => void services.runtime.respondToPlan(handoff.handoffId, 'reject')}>拒绝</button><button type="button" className="rewrite-send-button" disabled={!isApprovable(handoff.plan)} onClick={() => void services.runtime.respondToPlan(handoff.handoffId, 'approve')}><Check size={13} /> 批准 Plan v{handoff.plan.version}</button></div>}
      {handoff.status === 'approved' && retryableRunIds.has(handoff.runId) && <div className="rewrite-action-row"><button type="button" className="rewrite-send-button" onClick={() => void services.runtime.resumePlan(handoff.handoffId)}><RotateCw size={13} /> 重新继续</button></div>}
    </article>)}
    {runtime.planHandoffs.length === 0 && <p className="module-empty-state">暂无需要确认的计划。</p>}
  </section>;
}

function isApprovable(plan: Parameters<typeof PlanContractView>[0]['plan']): boolean {
  return plan.planState === 'ready_for_confirmation'
    && plan.completeness === 'complete'
    && !plan.qualityIssues.some((issue) => issue.severity === 'critical');
}

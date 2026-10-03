import { Check, ListChecks } from 'lucide-react';
import { useFeatureSnapshot } from '@renderer/core/runtime/features/feature-snapshot-store';
import type { FeaturePanelProps, ModuleServices } from '@renderer/core/modules/module-contract';
import type { RuntimePlanDecision } from '@renderer/core/runtime/runtime-projection-presenter';
import { PlanContractView } from './PlanContractView';
import { PanelEmptyState } from '@renderer/shared/ui/PanelEmptyState';
import { StatusPill } from '@renderer/shared/ui/StatusPill';
import { usePanelAction } from '@renderer/shared/ui/usePanelAction';
import './agent-plan.css';

export function AgentPlanPanel({ moduleId, services }: FeaturePanelProps): React.JSX.Element {
  const decisions = useFeatureSnapshot(services.decisions.view);
  const sessions = useFeatureSnapshot(services.sessions.view);
  const runs = useFeatureSnapshot(services.runs.view);
  const handoffs = sessions.selectedSessionId === null ? [] : decisions.planHandoffs.filter(handoff => (
    handoff.sessionId ?? runs.runs.find(run => run.runId === handoff.runId)?.sessionId
  ) === sessions.selectedSessionId);
  return <section className="agent-plan-panel" aria-labelledby={`${moduleId}-title`}>
    <header className="module-content-header"><div><span>当前会话</span><h1 id={`${moduleId}-title`}>执行计划</h1></div><StatusPill tone="neutral">{handoffs.filter(handoff => handoff.status === 'pending').length} 项待确认</StatusPill></header>
    <div className="agent-plan-body">
      {handoffs.map(handoff => <PlanHandoffCard key={`${handoff.handoffId}:${handoff.projectionVersion}`} handoff={handoff} services={services} />)}
      {handoffs.length === 0 && <PanelEmptyState icon={ListChecks} title="暂无执行计划" description={sessions.selectedSessionId ? '此会话需要确认的计划和已处理记录会显示在这里。' : '选择一条会话，查看对应的执行计划。'} />}
    </div>
  </section>;
}

function PlanHandoffCard({ handoff, services }: { handoff: RuntimePlanDecision; services: ModuleServices }): React.JSX.Element {
  const { pending, error, execute } = usePanelAction();
  const awaitingDecision = handoff.status === 'pending';
  const approvable = handoff.plan === null || isApprovable(handoff.plan);
  return <article className="plan-handoff-card">
    <header><h2>{handoff.title}</h2><StatusPill tone={awaitingDecision ? 'warning' : 'neutral'}>{decisionStatusLabel(handoff.status)}</StatusPill></header>
    {handoff.plan ? <PlanContractView plan={handoff.plan} /> : <div className="plan-summary">
      <p>{handoff.summary}</p><p>影响：{handoff.impactSummary}</p>
      <ol>{handoff.steps.map(step => <li key={step.stepId}><strong>{step.title}</strong>{step.detail && <p>{step.detail}</p>}</li>)}</ol>
    </div>}
    {awaitingDecision && !handoff.actionAvailable && <p className="plan-notice">此计划当前不可操作，等待任务状态更新。</p>}
    {awaitingDecision && !approvable && <p className="plan-notice">计划尚未完整或存在关键问题，暂不能批准。</p>}
    {error && <p className="plan-notice is-danger" role="alert">{error}</p>}
    {pending && <p className="plan-notice" role="status">正在提交决定…</p>}
    {awaitingDecision && handoff.actionAvailable && <footer className="plan-actions">
      <button type="button" className="secondary-button" disabled={pending} onClick={() => void execute(() => services.decisions.respondToPlan(handoff, 'reject'))}>拒绝</button>
      <button type="button" className="primary-button" disabled={pending || !approvable} onClick={() => void execute(() => services.decisions.respondToPlan(handoff, 'approve'))}><Check size={14} />批准计划</button>
    </footer>}
  </article>;
}

function isApprovable(plan: Parameters<typeof PlanContractView>[0]['plan']): boolean {
  return plan.planState === 'ready_for_confirmation' && plan.completeness === 'complete'
    && !plan.qualityIssues.some(issue => issue.severity === 'critical');
}

function decisionStatusLabel(status: RuntimePlanDecision['status']): string {
  switch (status) {
    case 'pending': return '待确认';
    case 'approved': return '已批准';
    case 'rejected': return '已拒绝';
    case 'expired': return '已过期';
  }
}

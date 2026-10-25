import { Check, ListChecks } from 'lucide-react';
import { useFeatureSnapshot } from '@renderer/core/runtime/features/feature-snapshot-store';
import type { FeaturePanelProps, ModuleServices } from '@renderer/core/modules/module-contract';
import type { RuntimePlanDecision } from '@renderer/core/runtime/runtime-projection-presenter';
import { PlanContractView } from './PlanContractView';
import { PanelEmptyState } from '@renderer/shared/ui/PanelEmptyState';
import { StatusPill } from '@renderer/shared/ui/StatusPill';
import { usePanelAction } from '@renderer/shared/ui/usePanelAction';
import './agent-plan.css';
import { DecisionDetailLinks } from '@renderer/shared/ui/DecisionDetailLinks';
import { ProjectionCatalogPager } from '@renderer/shared/ui/ProjectionCatalogPager';
import { usePanelDetailFocus } from '@renderer/shared/ui/usePanelDetailFocus';

export function AgentPlanPanel({ moduleId, services }: FeaturePanelProps): React.JSX.Element {
  const decisions = useFeatureSnapshot(services.decisions.view);
  const sessions = useFeatureSnapshot(services.sessions.view);
  const runs = useFeatureSnapshot(services.runs.view);
  const handoffs = sessions.selectedSessionId === null ? [] : decisions.planHandoffs.filter(handoff => (
    handoff.sessionId ?? runs.runs.find(run => run.runId === handoff.runId)?.sessionId
  ) === sessions.selectedSessionId);
  const pendingCount = decisions.sessionDecisionDirectory?.page.decisionKindCounts.plan ?? 0;
  const detailedIds = new Set(handoffs.map(handoff => handoff.handoffId));
  const summaries = decisions.sessionDecisionDirectory?.page.rows.flatMap(row => row.feature === 'decisions'
    && row.dto.kind === 'plan' && !detailedIds.has(row.dto.decisionId) ? [row.dto] : []) ?? [];
  return <section className="agent-plan-panel" aria-labelledby={`${moduleId}-title`}>
    <header className="module-content-header"><div><span>当前会话</span><h1 id={`${moduleId}-title`}>执行计划</h1></div><StatusPill tone="neutral">{sessions.selectedSessionId === null ? '未选择会话' : decisions.sessionDecisionDirectory === null ? '正在读取…' : `${pendingCount} 项待确认`}</StatusPill></header>
    <div className="agent-plan-body">
      <ProjectionCatalogPager key={sessions.selectedSessionId} window={decisions.sessionDecisionDirectory}
        navigate={direction => services.decisions.navigateSession(direction)} label="当前会话待确认操作" />
      <DecisionDetailLinks rows={summaries} services={services} />
      {handoffs.map(handoff => <PlanHandoffCard key={`${handoff.handoffId}:${handoff.projectionVersion}`} handoff={handoff} services={services} selected={decisions.openedDecisionId === handoff.handoffId} />)}
      {handoffs.length === 0 && summaries.length === 0 && <PanelEmptyState icon={ListChecks}
        title={pendingCount > 0 ? '待确认计划位于其他列表页' : '暂无待确认计划'}
        description={sessions.selectedSessionId ? '在待确认列表中选择计划，查看完整内容。' : '选择一条会话，查看对应的执行计划。'} />}
    </div>
  </section>;
}

function PlanHandoffCard({ handoff, services, selected }: { handoff: RuntimePlanDecision; services: ModuleServices; selected: boolean }): React.JSX.Element {
  const { pending, error, execute } = usePanelAction();
  const awaitingDecision = handoff.status === 'pending';
  const approvable = handoff.plan === null || isApprovable(handoff.plan);
  const detail = usePanelDetailFocus(selected, handoff.handoffId);
  return <article className="plan-handoff-card" ref={detail} tabIndex={-1} data-decision-id={handoff.handoffId} aria-current={selected}>
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

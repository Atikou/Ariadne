import { AlertTriangle, Bot, Clock3, Cpu, KeyRound, Radio } from 'lucide-react';
import { useFeatureSnapshot } from '@renderer/core/runtime/features/feature-snapshot-store';
import { formatRuntimeAvailability } from '@renderer/core/runtime/runtime-labels';
import type { ModuleServices } from '@renderer/core/modules/module-contract';
import type { SaveStatus } from './Workspace';

export function GlobalStatusBar({ services, saveStatus }: { services: ModuleServices; saveStatus: SaveStatus }): React.JSX.Element {
  const diagnostics = useFeatureSnapshot(services.diagnostics.view);
  const decisions = useFeatureSnapshot(services.decisions.view);
  const models = useFeatureSnapshot(services.models.view);
  const runs = useFeatureSnapshot(services.runs.view);
  const available = diagnostics.status.availability === 'ready';
  const activeRun = runs.runs.find((run) => run.parentRunId === undefined && run.origin === 'agent' && [
    'queued', 'running', 'waiting_decision', 'waiting_permission', 'waiting_plan_handoff', 'waiting_budget'
  ].includes(run.status));
  const pendingDecisions = [
    ...decisions.permissions,
    ...decisions.planHandoffs,
    ...decisions.userQuestions
  ].filter((request) => request.status === 'pending').length;
  const readyModel = models.models.find((model) => model.availability === 'ready');
  const warningCount = (diagnostics.lastError ? 1 : 0) + pendingDecisions;

  return <footer className="global-status-bar"><div>
    <span className={available ? 'is-success' : 'is-danger'} data-runtime-availability={diagnostics.status.availability}>
      <Radio size={11} /> Runtime {formatRuntimeAvailability(diagnostics.status.availability)}
    </span>
    <span><Cpu size={11} /> {readyModel?.label ?? '暂无可用模型'}</span>
    <span><Bot size={11} /> {activeRun?.userFacingLabel ?? 'Agent 空闲'}</span>
    <span><KeyRound size={11} /> {pendingDecisions > 0 ? `${pendingDecisions} 项待确认` : '权限受控'}</span>
  </div><div>
    <span><Clock3 size={11} /> {new Date(diagnostics.status.observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
    {warningCount > 0 && <span className="is-warning"><AlertTriangle size={11} /> {warningCount}</span>}
    <span>{saveStatus === 'saving' ? '正在保存布局…' : saveStatus === 'error' ? '布局保存失败' : '布局已保存'}</span>
  </div></footer>;
}

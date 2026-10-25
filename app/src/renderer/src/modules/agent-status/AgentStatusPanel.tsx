import { useState } from 'react';
import { Bot, CircleX, Clock3, RotateCw, Send, ShieldCheck, Square, Wrench } from 'lucide-react';
import { useFeatureSnapshot } from '@renderer/core/runtime/features/feature-snapshot-store';
import { formatRunStatus } from '@renderer/core/runtime/runtime-labels';
import type { FeaturePanelProps } from '@renderer/core/modules/module-contract';
import { StatusPill } from '@renderer/shared/ui/StatusPill';
import { PanelEmptyState } from '@renderer/shared/ui/PanelEmptyState';
import { runStatusTone, selectSessionRun } from './agent-status-model';
import type { RuntimeRun } from '@renderer/core/runtime/runtime-projection-presenter';
import { usePanelAction } from '@renderer/shared/ui/usePanelAction';
import './agent-status.css';
import { AgentRunDirectory } from './AgentRunDirectory';

export function AgentStatusPanel({ moduleId, services }: FeaturePanelProps): React.JSX.Element {
  const sessions = useFeatureSnapshot(services.sessions.view);
  const runView = useFeatureSnapshot(services.runs.view);
  const [scope, setScope] = useState<'all' | 'session'>('all');
  const run = runView.runs.find(candidate => candidate.runId === runView.openedRunId && candidate.sessionId === sessions.selectedSessionId)
    ?? selectSessionRun(runView.runs, sessions.selectedSessionId);
  return <div className="agent-status-workspace" data-empty-detail={run === undefined}>
    <AgentRunDirectory key={scope} services={services} scope={scope} openedRunId={run?.runId ?? null} onScope={setScope} />
    <AgentStatusContent key={run?.runId ?? sessions.selectedSessionId ?? 'none'} moduleId={moduleId} services={services} run={run} selectedSessionId={sessions.selectedSessionId} />
  </div>;
}

function AgentStatusContent({ moduleId, services, run, selectedSessionId }: FeaturePanelProps & { run: RuntimeRun | undefined; selectedSessionId: string | null }): React.JSX.Element {
  const { pending, error, execute } = usePanelAction();
  const [subagentDrafts, setSubagentDrafts] = useState<Record<string, string>>({});
  const [sendingSubagentId, setSendingSubagentId] = useState<string | null>(null);
  const [interruptingSubagentId, setInterruptingSubagentId] = useState<string | null>(null);
  const [subagentSendError, setSubagentSendError] = useState<{
    runId: string;
    message: string;
  } | null>(null);
  const decisions = useFeatureSnapshot(services.decisions.view);
  const runView = useFeatureSnapshot(services.runs.view);
  const agentRuns = runView.runSummaries;
  const progress = run?.progress === undefined ? null : Math.round(run.progress * 100);
  const recoveryChoices = run === undefined ? [] : services.decisions.recoveryChoices(run);
  const tone = runStatusTone(run?.status ?? 'idle');
  const runActivities = run ? runView.activities.filter((activity) => activity.runId === run.runId) : [];
  const subagents = run
    ? agentRuns.filter((candidate) => candidate.parentRunId === run.runId)
    : [];

  if (!run) return <section className="agent-status-panel" aria-labelledby={`${moduleId}-title`}>
    <header className="module-content-header"><div><span>当前会话</span><h1 id={`${moduleId}-title`}>任务状态</h1></div><StatusPill tone="neutral">空闲</StatusPill></header>
    <PanelEmptyState compact icon={Bot} title={selectedSessionId ? '当前会话尚未打开任务' : '尚未选择会话'} description={selectedSessionId ? '从上方目录选择任务查看详情；全部会话的记录不会自动成为当前会话的任务。' : '上方目录可查看全部会话的任务，选择任务后会打开对应会话。'} />
  </section>;

  return <section className="agent-status-panel" aria-labelledby={`${moduleId}-title`}>
    <header className="module-content-header"><div><span>当前 Agent</span><h1 id={`${moduleId}-title`}>任务状态</h1></div><StatusPill tone={tone}>{run ? formatRunStatus(run.status) : '空闲'}</StatusPill></header>
    <div className="agent-status-body">
    <div className="agent-goal"><span>当前目标</span><p>{run?.title ?? '当前没有正在运行的 Agent 任务。'}</p></div>
    <div className="agent-progress"><div><span>执行状态</span><strong>{['completed', 'failed', 'cancelled'].includes(run.status) ? formatRunStatus(run.status) : run.userFacingLabel ?? formatRunStatus(run.status)}</strong></div>{progress !== null && <><span>{progress}%</span><div className="progress-track" role="progressbar" aria-label="任务进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><i style={{ width: `${progress}%` }} /></div></>}</div>
    <div className="status-section"><h2>最近活动</h2><ol>{runActivities.slice(-5).map((activity) => <li className={activity.status === 'completed' ? 'is-done' : activity.status === 'failed' ? 'is-failed' : activity.status === 'running' ? 'is-current' : ''} key={activity.activityId}>{activity.title}{activity.status === 'failed' && <span> · 失败</span>}</li>)}{runActivities.length === 0 && <li>暂无活动记录。</li>}</ol></div>
    {subagents.length > 0 && <div className="status-section"><h2>子任务</h2><ol>{subagents.map((subagent) => <li className={subagent.status === 'completed' ? 'is-done' : subagent.status === 'failed' ? 'is-failed' : ['running', 'queued'].includes(subagent.status) ? 'is-current' : ''} key={subagent.runId}>
      <span>{subagent.title} · {formatRunStatus(subagent.status)}{subagent.subagentMode === 'continuable' ? ' · 可继续' : ''}{subagent.subagentProviderId === undefined ? '' : ` · ${subagent.subagentProviderId}`}</span>
      {run && subagent.subagentMode === 'continuable' && subagent.status === 'running' && <div className="agent-controls">
        <button type="button" disabled={interruptingSubagentId !== null} onClick={() => {
          setSubagentSendError(null);
          setInterruptingSubagentId(subagent.runId);
          void services.runs.interruptSubagent(run, subagent).catch((error: unknown) => {
            setSubagentSendError({
              runId: subagent.runId,
              message: error instanceof Error ? error.message : 'SubAgent 中断失败'
            });
          }).finally(() => setInterruptingSubagentId(null));
        }}>
          <Square size={12} /> {interruptingSubagentId === subagent.runId ? '中断中' : '中断本轮'}
        </button>
        {subagentSendError?.runId === subagent.runId && <p role="alert">{subagentSendError.message}</p>}
      </div>}
      {run && subagent.subagentMode === 'continuable' && subagent.status === 'paused' && <form className="subagent-follow-up" onSubmit={(event) => {
        event.preventDefault();
        const content = (subagentDrafts[subagent.runId] ?? '').trim();
        if (content.length === 0 || sendingSubagentId !== null) return;
        setSubagentSendError(null);
        setSendingSubagentId(subagent.runId);
        void services.runs.sendSubagentInput(run, subagent, content).then(() => {
          setSubagentDrafts((current) => ({ ...current, [subagent.runId]: '' }));
        }).catch((error: unknown) => {
          setSubagentSendError({
            runId: subagent.runId,
            message: error instanceof Error ? error.message : 'SubAgent 后续输入发送失败'
          });
        }).finally(() => setSendingSubagentId(null));
      }}>
        <textarea
          aria-label={`继续 ${subagent.title}`}
          value={subagentDrafts[subagent.runId] ?? ''}
          onChange={(event) => setSubagentDrafts((current) => ({
            ...current,
            [subagent.runId]: event.target.value
          }))}
          placeholder="向这个 SubAgent 发送后续要求"
          rows={2}
        />
        <button type="submit" disabled={sendingSubagentId !== null || (subagentDrafts[subagent.runId] ?? '').trim().length === 0}>
          <Send size={12} /> {sendingSubagentId === subagent.runId ? '发送中' : '继续'}
        </button>
        {subagentSendError?.runId === subagent.runId && <p role="alert">{subagentSendError.message}</p>}
      </form>}
    </li>)}</ol></div>}
    <div className="status-section"><h2>执行概况</h2><div className="context-grid"><span><Wrench size={13} /> {runActivities.filter((activity) => activity.activityType === 'tool').length} 次工具调用</span><span><ShieldCheck size={13} /> {decisions.decisionSummaries.filter(request => request.status === 'pending' && (request.runId === run.runId || subagents.some(child => child.runId === request.runId))).length} 项待确认（当前页）</span><span><Clock3 size={13} /> {run.startedAt ? new Date(run.startedAt).toLocaleTimeString() : '—'}</span></div></div>
    {run?.status === 'waiting_budget' && <div className="status-section">
      <h2>执行预算</h2>
      <p>
        本轮在安全检查点主动让出执行权
        {run.budgetExhausted ? `（${run.budgetExhausted}）` : ''}，不是执行失败。
      </p>
      {run.budgetUsage && <p>
        已累计使用 {run.budgetUsage.modelTurns} 次模型调用、{run.budgetUsage.toolCalls} 次工具调用。
      </p>}
      {run.origin === 'projection' && <div className="agent-controls">
        <button type="button" disabled={pending} onClick={() => void execute(() => services.decisions.resumeBudget(run))}>
          <RotateCw size={13} /> 按建议预算继续
        </button>
        <button type="button" disabled={pending} onClick={() => void execute(() => services.runs.requestCancellation(run))}>
          <Square size={13} /> 停止任务
        </button>
      </div>}
    </div>}
    {run?.status === 'paused' && <div className="status-section">
      <h2>任务已暂停</h2>
      <p>{run.detail ?? '任务由用户或上层调度暂停。'}</p>
    </div>}
    {run?.status === 'interrupted' && <div className="status-section">
      <h2>恢复处理</h2>
      <p>{run.cancellationPending
        ? '已收到取消请求。工具执行结果仍不确定，需要明确处理后才能结束任务。'
        : run.detail ?? '执行结果尚未确认，请选择恢复处理方式。'}</p>
      {run.origin === 'projection' && <div className="agent-controls">
        {recoveryChoices.includes('retry') && <button type="button" disabled={pending} onClick={() => void execute(() => services.decisions.recoverRun(run, 'resume'))}><RotateCw size={13} /> 从检查点继续</button>}
        {recoveryChoices.includes('mark_failed') && <button type="button" disabled={pending} onClick={() => void execute(() => services.decisions.recoverRun(run, 'mark_failed'))}><CircleX size={13} /> 标记失败</button>}
        {recoveryChoices.includes('cancel_run') && <button type="button" disabled={pending} onClick={() => void execute(() => services.decisions.recoverRun(run, 'cancel'))}><Square size={13} /> 确认结束任务</button>}
        {recoveryChoices.length === 0 && !run.cancellationPending && <button type="button" disabled={pending} onClick={() => void execute(() => services.runs.requestCancellation(run))}><Square size={13} /> 取消任务</button>}
      </div>}
    </div>}
    </div>
    {error && <p className="agent-action-feedback is-danger" role="alert">{error}</p>}
    {pending && <p className="agent-action-feedback" role="status">正在提交操作…</p>}
    {run.origin === 'projection' && !['completed', 'failed', 'cancelled', 'interrupted', 'waiting_budget', 'cancelling'].includes(run.status) && <footer className="agent-controls"><button type="button" disabled={pending} onClick={() => void execute(() => services.runs.requestCancellation(run))}><Square size={13} /> 取消任务</button></footer>}
  </section>;
}

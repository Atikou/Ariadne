import { useState } from 'react';
import { CircleX, Clock3, RotateCw, Send, ShieldCheck, Square, Wrench } from 'lucide-react';
import { useRuntimeSnapshot } from '@renderer/core/runtime/runtime-store';
import { formatRunStatus } from '@renderer/core/runtime/runtime-labels';
import type { FeaturePanelProps } from '@renderer/core/modules/module-contract';
import { StatusPill } from '@renderer/shared/ui/StatusPill';

export function AgentStatusPanel({ moduleId, services }: FeaturePanelProps): React.JSX.Element {
  const [subagentDrafts, setSubagentDrafts] = useState<Record<string, string>>({});
  const [sendingSubagentId, setSendingSubagentId] = useState<string | null>(null);
  const [interruptingSubagentId, setInterruptingSubagentId] = useState<string | null>(null);
  const [subagentSendError, setSubagentSendError] = useState<{
    runId: string;
    message: string;
  } | null>(null);
  const runtime = useRuntimeSnapshot(services.runtime);
  const agentRuns = runtime.runs;
  const run = agentRuns.find((candidate) => candidate.parentRunId === undefined && [
    'queued', 'running', 'waiting_permission', 'waiting_decision',
    'waiting_budget', 'waiting_children', 'cancelling', 'paused', 'interrupted'
  ].includes(candidate.status)) ?? agentRuns.find((candidate) => candidate.parentRunId === undefined) ?? agentRuns[0];
  const progress = Math.round((run?.progress ?? (run?.status === 'completed' ? 1 : 0)) * 100);
  const tone = run?.status === 'completed'
    ? 'success'
    : run?.status === 'failed'
      ? 'danger'
      : run?.status === 'waiting_permission'
        || run?.status === 'waiting_decision'
        || run?.status === 'waiting_budget'
        || run?.status === 'waiting_children'
        || run?.status === 'cancelling'
        || run?.status === 'paused'
        || run?.status === 'interrupted'
        ? 'warning'
        : run?.status === 'running'
          ? 'running'
          : 'neutral';
  const runActivities = run ? runtime.activities.filter((activity) => activity.runId === run.runId) : [];
  const subagents = run
    ? agentRuns.filter((candidate) => candidate.parentRunId === run.runId)
    : [];

  return <section className="agent-status-panel" aria-labelledby={`${moduleId}-title`}>
    <header className="module-content-header"><div><span>当前 Agent</span><h1 id={`${moduleId}-title`}>任务状态</h1></div><StatusPill tone={tone}>{run ? formatRunStatus(run.status) : '空闲'}</StatusPill></header>
    <div className="agent-goal"><span>当前目标</span><p>{run?.title ?? '当前没有正在运行的 Agent 任务。'}</p></div>
    <div className="agent-progress"><div><span>当前步骤</span><strong>{run?.userFacingLabel ?? runtime.status.detail ?? '等待任务'}</strong></div><span>{progress}%</span><div className="progress-track"><i style={{ width: `${progress}%` }} /></div></div>
    <div className="status-section"><h2>最近活动</h2><ol>{runActivities.slice(-5).map((activity) => <li className={activity.status === 'completed' ? 'is-done' : activity.status === 'running' ? 'is-current' : ''} key={activity.activityId}>{activity.title}</li>)}{runActivities.length === 0 && <li>暂无活动记录。</li>}</ol></div>
    {subagents.length > 0 && <div className="status-section"><h2>SubAgent</h2><ol>{subagents.map((subagent) => <li className={subagent.status === 'completed' ? 'is-done' : ['running', 'queued'].includes(subagent.status) ? 'is-current' : ''} key={subagent.runId}>
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
    <div className="status-section"><h2>执行概况</h2><div className="context-grid"><span><Wrench size={13} /> {runActivities.filter((activity) => activity.activityType === 'tool').length} 次工具调用</span><span><ShieldCheck size={13} /> {runtime.permissions.filter((request) => request.status === 'pending').length} 项待确认</span><span><Clock3 size={13} /> {run?.startedAt ? new Date(run.startedAt).toLocaleTimeString() : '—'}</span></div></div>
    {run?.status === 'waiting_budget' && <div className="status-section">
      <h2>执行预算</h2>
      <p>
        本轮在安全检查点主动让出执行权
        {run.budgetExhausted ? `（${run.budgetExhausted}）` : ''}，不是执行失败。
      </p>
      {run.budgetUsage && <p>
        已累计使用 {run.budgetUsage.modelTurns} 次模型调用、{run.budgetUsage.toolCalls} 次工具调用。
      </p>}
      {run.origin !== 'projection' && <div className="agent-controls">
        <button type="button" onClick={() => void services.decisions.resumeBudget(run)}>
          <RotateCw size={13} /> 按建议预算继续
        </button>
        <button type="button" onClick={() => void services.runs.requestCancellation(run)}>
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
      <p>{run.detail ?? (run.recoveryStatus === 'recoverable'
        ? '运行停在安全检查点，可以从原位置继续。'
        : '存在状态不确定的非幂等副作用，需要结束本次运行。')}</p>
      {run.origin !== 'projection' && <div className="agent-controls">
        {run.recoveryStatus === 'recoverable'
          ? <button type="button" onClick={() => void services.decisions.recoverRun(run, 'resume')}><RotateCw size={13} /> 从检查点继续</button>
          : <>
              <button type="button" onClick={() => void services.decisions.recoverRun(run, 'mark_failed')}><CircleX size={13} /> 标记失败</button>
              <button type="button" onClick={() => void services.decisions.recoverRun(run, 'cancel')}><Square size={13} /> 取消任务</button>
            </>}
      </div>}
    </div>}
    {run && run.origin !== 'projection' && !['completed', 'failed', 'cancelled', 'interrupted', 'waiting_budget', 'cancelling'].includes(run.status) && <footer className="agent-controls"><button type="button" onClick={() => void services.runs.requestCancellation(run)}><Square size={13} /> 取消任务</button></footer>}
  </section>;
}

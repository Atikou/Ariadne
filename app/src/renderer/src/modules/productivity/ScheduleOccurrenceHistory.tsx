import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScheduleOccurrenceFeatureStore, ScheduleOccurrencePage } from '@renderer/core/runtime/features/schedule-occurrence-feature-store';
import { usePanelAction } from '@renderer/shared/ui/usePanelAction';
import { ScheduleExecutionResult, scheduleExecutionPending } from './ScheduleExecutionResult';

type Occurrence = ScheduleOccurrencePage['occurrences'][number];
const statusText: Record<Occurrence['status'], string> = {
  pending: '等待提交', dispatching: '提交中／自动重试', submitted: '已提交到会话', failed: '提交失败', cancelled: '已撤回'
};
const errorText: Record<NonNullable<Occurrence['errorCode']>, string> = {
  schedule_session_unavailable: '会话暂不可用', schedule_cancelled: '调度已取消',
  schedule_submission_deadline_exceeded: '提交超时', schedule_worker_stopped: '服务停止，等待恢复',
  conversation_version_conflict: '提交时会话已更新', schedule_submission_rejected: '会话拒绝了提交',
  schedule_submission_uncertain: '提交结果待确认', schedule_submission_failed: '提交异常'
};

export function ScheduleOccurrenceHistory({ submissions, workspaceId, sessionId, refreshToken, disabled, openSession }: {
  submissions: ScheduleOccurrenceFeatureStore; workspaceId: string; sessionId: string;
  refreshToken: number; disabled: boolean; openSession(): Promise<void>;
}): React.JSX.Element {
  const [page, setPage] = useState<ScheduleOccurrencePage | null>(null);
  const [cursors, setCursors] = useState<ScheduleOccurrencePage['nextCursor'][]>([null]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const mounted = useRef(false);
  const action = usePanelAction();
  const before = cursors.at(-1) ?? null;
  const refresh = useCallback(async () => {
    if (!mounted.current) return;
    const revision = ++request.current;
    setLoading(true);
    try {
      const next = await submissions.query(workspaceId, sessionId, before);
      if (mounted.current && revision === request.current) { setPage(next); setError(null); }
    } catch (failure) {
      if (mounted.current && revision === request.current) setError(failure instanceof Error ? failure.message : '提交记录暂不可用');
    } finally {
      if (mounted.current && revision === request.current) setLoading(false);
    }
  }, [submissions, workspaceId, sessionId, before]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; request.current++; };
  }, [refresh, refreshToken]);
  const pending = page?.occurrences.some(item => item.status === 'pending' || item.status === 'dispatching' || scheduleExecutionPending(item.execution)) ?? false;
  useEffect(() => {
    if (!pending || disabled || action.pending) return;
    const timer = setInterval(() => { void refresh(); }, 5_000);
    return () => clearInterval(timer);
  }, [pending, disabled, action.pending, refresh]);
  const busy = disabled || action.pending || loading;
  return <article className="productivity-card schedule-occurrence-history">
    <h2>调度提交记录</h2>
    <p>提交状态与实际执行结果分别显示。自动提交最多尝试 8 次，退避时间在重启后保留；达到上限后每次手动重试只再尝试一次。</p>
    {loading && <p role="status">正在加载提交记录…</p>}
    {error && <p role="alert">记录加载失败：{error}</p>}
    {action.error && <p role="alert">操作失败：{action.error}</p>}
    <button type="button" disabled={busy} onClick={() => { void refresh(); }}>刷新提交记录</button>
    {!loading && page?.occurrences.length === 0 && <p>暂无提交记录。</p>}
    <ul>{page?.occurrences.map(item => <li key={item.occurrenceId} data-occurrence-id={item.occurrenceId}>
      <span>{item.prompt}</span>
      <span>{new Date(item.dueAt).toLocaleString()} · {statusText[item.status]}</span>
      <small>已尝试 {item.attempts} 次{item.errorCode ? ` · ${errorText[item.errorCode]}` : ''}</small>
      {item.nextAttemptAt && <small>下次重试：{new Date(item.nextAttemptAt).toLocaleString()}</small>}
      {item.attemptDeadlineAt && <small>本次提交期限：{new Date(item.attemptDeadlineAt).toLocaleString()}</small>}
      {item.execution && <ScheduleExecutionResult execution={item.execution} disabled={busy}
        openSession={() => { void action.execute(openSession); }} />}
      {item.status === 'failed' && <button type="button" disabled={busy || !item.canRetry} onClick={() => {
        void action.execute(async () => {
          await submissions.retry({ workspaceId, sessionId, occurrenceId: item.occurrenceId, expectedAttempts: item.attempts });
          await refresh();
        });
      }}>重试提交</button>}
    </li>)}</ul>
    <div className="productivity-inline">
      <button type="button" disabled={busy || cursors.length === 1} onClick={() => { setPage(null); setCursors(previous => previous.slice(0, -1)); }}>较新记录</button>
      <button type="button" disabled={busy || !page?.nextCursor} onClick={() => {
        if (page?.nextCursor) { setPage(null); setCursors(previous => [...previous, page.nextCursor]); }
      }}>较早记录</button>
    </div>
  </article>;
}

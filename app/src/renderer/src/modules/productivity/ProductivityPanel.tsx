import { useEffect, useMemo, useState } from 'react';
import type { FeaturePanelProps } from '@renderer/core/modules/module-contract';
import { useFeatureSnapshot } from '@renderer/core/runtime/features/feature-snapshot-store';
import type {
  ProductivitySchedule,
  ProductivitySnapshot
} from '@renderer/core/runtime/features/productivity-feature-store';

export function ProductivityPanel({ moduleId, services }: FeaturePanelProps): React.JSX.Element {
  const sessions = useFeatureSnapshot(services.sessions.view);
  const session = sessions.sessions.find((item) => item.sessionId === sessions.selectedSessionId);
  const [snapshot, setSnapshot] = useState<ProductivitySnapshot | null>(null);
  const [schedules, setSchedules] = useState<readonly ProductivitySchedule[]>([]);
  const [goalTitle, setGoalTitle] = useState('');
  const [todoTitle, setTodoTitle] = useState('');
  const [schedulePrompt, setSchedulePrompt] = useState('');
  const [scheduleAt, setScheduleAt] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    if (!session) { setSnapshot(null); setSchedules([]); return; }
    const [next, nextSchedules] = await Promise.all([
      services.productivity.query(session.workspaceId, session.sessionId),
      services.productivity.querySchedules(session.workspaceId, session.sessionId)
    ]);
    setSnapshot(next); setSchedules(nextSchedules); setGoalTitle(next.goal?.title ?? '');
  };
  useEffect(() => { setError(null); void refresh().catch(() => setError('目标与工作流暂不可用')); }, [session?.sessionId]);
  const running = snapshot?.workflows.find((workflow) => workflow.status === 'running');
  const pending = useMemo(() => snapshot?.todos.filter((todo) => todo.status === 'pending') ?? [], [snapshot]);

  const run = (operation: () => Promise<unknown>): void => {
    setError(null);
    void operation().then(refresh, () => setError('操作发生版本冲突，请刷新后重试'));
  };
  if (!session) return <section className="simple-module-panel"><p className="module-empty-state">请先选择一个会话。</p></section>;

  return <section className="simple-module-panel productivity-panel" aria-labelledby={`${moduleId}-title`}>
    <header className="module-content-header"><div><span>同一会话权威</span><h1 id={`${moduleId}-title`}>目标、待办与工作流</h1></div></header>
    {error ? <p role="status">{error}</p> : null}
    <article className="productivity-card">
      <h2>Goal</h2>
      <input value={goalTitle} onChange={(event) => setGoalTitle(event.target.value)} placeholder="目标" />
      <button type="button" onClick={() => run(() => services.productivity.putGoal({
        workspaceId: session.workspaceId, sessionId: session.sessionId,
        goalId: snapshot?.goal?.goalId ?? crypto.randomUUID(),
        expectedVersion: snapshot?.goal?.version ?? null, title: goalTitle,
        phase: snapshot?.goal?.phase ?? 'active', status: snapshot?.goal?.status ?? 'active',
        roundCap: snapshot?.goal?.roundCap ?? 32
      }))}>保存目标（CAS）</button>
      {snapshot?.goal ? <small>v{snapshot.goal.version} · {snapshot.goal.phase} · {snapshot.goal.status}</small> : null}
    </article>
    <article className="productivity-card">
      <h2>Todo 快照</h2>
      <div className="productivity-inline"><input value={todoTitle} onChange={(event) => setTodoTitle(event.target.value)} placeholder="新增待办" /><button type="button" disabled={!snapshot?.goal || !todoTitle.trim()} onClick={() => run(async () => {
        if (!snapshot?.goal) return;
        await services.productivity.replaceTodos({
          workspaceId: session.workspaceId, sessionId: session.sessionId,
          goalId: snapshot.goal.goalId, expectedGoalVersion: snapshot.goal.version,
          expectedRevision: snapshot.todoRevision,
          items: [...snapshot.todos.map(({ todoId, title, status }) => ({ todoId, title, status })), { todoId: crypto.randomUUID(), title: todoTitle.trim(), status: 'pending' }]
        });
        setTodoTitle('');
      })}>添加</button></div>
      <ol>{snapshot?.todos.map((todo) => <li key={todo.todoId}><span>{todo.title}</span><small>{todo.status}</small></li>)}</ol>
      <button type="button" disabled={!snapshot?.goal || snapshot.todoRevision === null || pending.length === 0 || Boolean(running)} onClick={() => run(() => services.productivity.startWorkflow({
        workspaceId: session.workspaceId, sessionId: session.sessionId,
        workflowId: crypto.randomUUID(), goalId: snapshot!.goal!.goalId,
        expectedGoalVersion: snapshot!.goal!.version, expectedTodoRevision: snapshot!.todoRevision!,
        todoIds: pending.map((todo) => todo.todoId), maxConcurrency: Math.min(4, pending.length),
        maxTransitions: pending.length, deadlineAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString()
      }))}>启动受限 Workflow</button>
    </article>
    {running ? <article className="productivity-card"><h2>Workflow v{running.version}</h2><p>并发 {running.activeTodoIds.length}/{running.maxConcurrency} · 预算 {running.transitionsUsed}/{running.maxTransitions}</p>{running.activeTodoIds.map((todoId) => <div className="productivity-inline" key={todoId}><span>{snapshot?.todos.find((todo) => todo.todoId === todoId)?.title ?? todoId}</span><button type="button" onClick={() => run(() => services.productivity.advanceWorkflow({ workspaceId: session.workspaceId, sessionId: session.sessionId, workflowId: running.workflowId, expectedVersion: running.version, completed: [{ todoId, outcome: 'completed', summary: 'user_confirmed_complete' }] }))}>完成</button><button type="button" onClick={() => run(() => services.productivity.advanceWorkflow({ workspaceId: session.workspaceId, sessionId: session.sessionId, workflowId: running.workflowId, expectedVersion: running.version, completed: [{ todoId, outcome: 'failed', summary: 'user_reported_failure' }] }))}>失败</button></div>)}<button type="button" onClick={() => run(() => services.productivity.cancelWorkflow({ workspaceId: session.workspaceId, sessionId: session.sessionId, workflowId: running.workflowId, expectedVersion: running.version }))}>取消并等待子任务静止</button></article> : null}
    <article className="productivity-card"><h2>Schedule → 普通 v3 Turn</h2><input value={schedulePrompt} onChange={(event) => setSchedulePrompt(event.target.value)} placeholder="触发时发送的任务" /><input type="datetime-local" value={scheduleAt} onChange={(event) => setScheduleAt(event.target.value)} /><button type="button" disabled={!schedulePrompt.trim() || !scheduleAt} onClick={() => run(async () => { await services.productivity.createSchedule({ workspaceId: session.workspaceId, sessionId: session.sessionId, scheduleId: crypto.randomUUID(), prompt: schedulePrompt.trim(), timing: { kind: 'once', at: new Date(scheduleAt).toISOString(), missPolicy: 'run_once' } }); setSchedulePrompt(''); setScheduleAt(''); })}>创建一次性调度</button><ul>{schedules.map((schedule) => <li key={schedule.scheduleId}><span>{schedule.prompt}</span><small>{schedule.status} · {schedule.nextFireAt ?? '无下次'}</small>{schedule.status === 'active' || schedule.status === 'paused' ? <button type="button" onClick={() => run(() => services.productivity.transitionSchedule({ workspaceId: session.workspaceId, sessionId: session.sessionId, scheduleId: schedule.scheduleId, expectedVersion: schedule.version, action: schedule.status === 'active' ? 'pause' : 'resume' }))}>{schedule.status === 'active' ? '暂停' : '继续'}</button> : null}</li>)}</ul></article>
  </section>;
}

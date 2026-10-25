import { useCallback, useEffect, useRef, useState } from 'react';
import type { FeaturePanelProps } from '@renderer/core/modules/module-contract';
import { useFeatureSnapshot } from '@renderer/core/runtime/features/feature-snapshot-store';
import type { ProductivityGoal, ProductivitySchedule, ProductivitySnapshot } from '@renderer/core/runtime/features/productivity-feature-store';
import { usePanelAction } from '@renderer/shared/ui/usePanelAction';
import { ScheduleOccurrenceHistory } from './ScheduleOccurrenceHistory';
import { ProductivityTaskFaults } from './ProductivityTaskFaults';
import { ProductivityGoalEditor } from './ProductivityGoalEditor';
import { ProductivityTodos } from './ProductivityTodos';
import { ProductivityWorkflows } from './ProductivityWorkflows';
import { ProductivitySchedules } from './ProductivitySchedules';
import { autonomyIsActive, productivityErrorText } from './ProductivityPresentation';
import type { TodoReplacement } from './ProductivityTodoDialog';
import './productivity.css';

export function ProductivityPanel(props: FeaturePanelProps): React.JSX.Element {
  const sessions = useFeatureSnapshot(props.services.sessions.view);
  const session = sessions.sessions.find(item => item.sessionId === sessions.selectedSessionId);
  if (!session) return <section className="simple-module-panel"><p className="module-empty-state">请先选择一个会话。</p></section>;
  return <SessionProductivityPanel key={JSON.stringify([session.workspaceId, session.sessionId])} {...props} session={session} />;
}

function SessionProductivityPanel({ moduleId, services, session }: FeaturePanelProps & {
  session: { workspaceId: string; sessionId: string };
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<ProductivitySnapshot | null>(null);
  const [schedules, setSchedules] = useState<readonly ProductivitySchedule[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submission, setSubmission] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const request = useRef(0), mounted = useRef(false);
  const action = usePanelAction(productivityErrorText);
  const { workspaceId, sessionId } = session;
  const refresh = useCallback(async (): Promise<void> => {
    if (!mounted.current) return;
    const revision = ++request.current;
    const [next, nextSchedules] = await Promise.all([
      services.productivity.query(workspaceId, sessionId), services.productivity.querySchedules(workspaceId, sessionId)
    ]);
    if (!mounted.current || revision !== request.current) return;
    setSnapshot(next); setSchedules(nextSchedules); setLoadError(null); setRefreshToken(revision);
  }, [services.productivity, workspaceId, sessionId]);
  const reload = useCallback(() => {
    const revision = request.current + 1;
    void refresh().catch((error: unknown) => {
      if (mounted.current && revision === request.current) setLoadError(error instanceof Error ? error.message : '目标与工作流暂不可用');
    });
  }, [refresh]);
  useEffect(() => { mounted.current = true; reload(); return () => { mounted.current = false; request.current++; }; }, [reload]);
  const running = snapshot?.workflows.filter(item => item.status === 'running' || item.status === 'cancelling') ?? [];
  const autonomyActive = autonomyIsActive(snapshot?.goal);
  const hasActiveSchedules = schedules.some(item => item.status === 'active');
  useEffect(() => {
    if ((!running.length && !hasActiveSchedules && !autonomyActive) || action.pending) return;
    const timer = setInterval(reload, 5000); return () => clearInterval(timer);
  }, [running.length, hasActiveSchedules, autonomyActive, action.pending, reload]);
  const run = (operation: () => Promise<unknown>): void => {
    void action.execute(async () => {
      request.current++; setSubmission(false);
      await operation(); if (!mounted.current) return;
      setSubmission(true);
      try { await refresh(); } catch (error) {
        if (mounted.current) setLoadError(error instanceof Error ? error.message : '读取最新状态失败，请刷新。');
      }
    });
  };
  const onGoal = (goal: ProductivityGoal): void => {
    if (mounted.current) setSnapshot(current => current ? { ...current, goal } : current);
  };
  const replace = async (base: ProductivitySnapshot, items: TodoReplacement): Promise<void> => {
    if (!base.goal) throw new Error('请先建立目标。');
    const revision = await services.productivity.replaceTodos({ workspaceId, sessionId, goalId: base.goal.goalId,
      expectedGoalVersion: base.goal.version, expectedRevision: base.todoRevision, items });
    if (mounted.current) setSnapshot(current => current?.goal?.goalId === base.goal!.goalId && current.goal.version === base.goal!.version
      && (current.todoRevision ?? 0) <= revision ? { ...current, todoRevision: revision, todos: items.map((item, ordinal) => ({ ...item, ordinal })) } : current);
  };
  const startWorkflow = (): void => {
    if (!snapshot?.goal || snapshot.todoRevision === null) return;
    const base = snapshot, goal = snapshot.goal, pending = snapshot.todos.filter(item => item.status === 'pending');
    run(() => services.productivity.startWorkflow({ workspaceId, sessionId, workflowId: crypto.randomUUID(), goalId: goal.goalId,
      expectedGoalVersion: goal.version, expectedTodoRevision: base.todoRevision!, todoIds: pending.map(item => item.todoId),
      maxConcurrency: Math.min(4, pending.length), executionMode: 'agent', maxTransitions: pending.length,
      deadlineAt: new Date(Date.now() + 24 * 60 * 60000).toISOString() }));
  };
  return <section className="simple-module-panel productivity-panel" aria-labelledby={moduleId + '-title'}>
    <header className="module-content-header"><div><span>当前会话</span><h1 id={moduleId + '-title'}>目标与任务进度</h1></div>
      <button type="button" disabled={action.pending} onClick={reload}>刷新</button></header>
    {!snapshot && !loadError && <p role="status">正在加载当前会话…</p>}
    {loadError && <p role="alert">加载失败：{loadError}</p>}
    {action.error && <p role="alert">操作失败：{productivityErrorText(action.error)}</p>}
    {action.pending && <p role="status">正在提交并读取最新状态…</p>}
    {submission && !action.pending && <p role="status">操作已提交。任务是否完成以以下执行状态与结果为准。</p>}
    <fieldset className="productivity-controls" disabled={action.pending || !snapshot}>
      <ProductivityGoalEditor goal={snapshot?.goal ?? null} workspaceId={workspaceId} sessionId={sessionId} productivity={services.productivity}
        hasRunningWorkflow={running.length > 0} run={run} onGoal={onGoal} openSession={id => run(() => services.sessions.select(id))} />
      <ProductivityTaskFaults faults={services.productivity.taskFaults} workspaceId={workspaceId} sessionId={sessionId}
        refreshToken={refreshToken} onReconciled={reload} openSession={id => services.sessions.select(id)} />
      {snapshot && <ProductivityTodos snapshot={snapshot} busy={action.pending} replace={replace} run={run} startWorkflow={startWorkflow} />}
      {snapshot && <ProductivityWorkflows snapshot={snapshot} productivity={services.productivity} workspaceId={workspaceId} sessionId={sessionId}
        run={run} openSession={id => services.sessions.select(id)} />}
      <ProductivitySchedules productivity={services.productivity} schedules={schedules} workspaceId={workspaceId} sessionId={sessionId}
        disabled={action.pending || !snapshot} run={run} />
    </fieldset>
    <details className="productivity-schedules"><summary>调度提交与执行记录</summary>
      <ScheduleOccurrenceHistory submissions={services.productivity.scheduleOccurrences} workspaceId={workspaceId} sessionId={sessionId}
        openSession={() => services.sessions.select(sessionId)} refreshToken={refreshToken} disabled={action.pending || !snapshot} />
    </details>
  </section>;
}

import { useState } from 'react';
import type { ProductivityFeatureStore, ProductivityGoal } from '@renderer/core/runtime/features/productivity-feature-store';
import { autonomyStatusText as labels, autonomyIsActive } from './ProductivityPresentation';
import { useRevisionDraft } from '@renderer/shared/ui/useRevisionDraft';
import { RevisionDraftConflict } from '@renderer/shared/ui/RevisionDraftConflict';
function localDatetime(iso: string): string {
  const date = new Date(iso); return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
export function GoalAutonomyControls({ goal, productivity, hasRunningWorkflow, run, openSession }: {
  goal: ProductivityGoal; productivity: ProductivityFeatureStore; hasRunningWorkflow: boolean;
  run(operation: () => Promise<unknown>): void; openSession(sessionId: string): void;
}): React.JSX.Element {
  const autonomy = goal.autonomy;
  const [defaultDeadline] = useState(() => localDatetime(new Date(Date.now() + 24 * 60 * 60_000).toISOString()));
  const draft = useRevisionDraft({ criteria: autonomy?.criteria.join('\n') ?? '',
    deadline: autonomy?.deadlineAt ? localDatetime(autonomy.deadlineAt) : defaultDeadline,
    concurrency: autonomy?.maxConcurrency ?? 4 }, String(goal.version));
  const { criteria, deadline, concurrency } = draft.value;
  const active = autonomyIsActive(goal);
  const items = criteria.split('\n').map(text => text.trim()).filter(Boolean);
  const valid = items.length > 0 && items.length <= 32 && items.every(text => text.length <= 2_000)
    && new Set(items).size === items.length && Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 16
    && Number.isFinite(new Date(deadline).getTime()) && new Date(deadline).getTime() > Date.now();
  const scope = { workspaceId: goal.workspaceId, sessionId: goal.sessionId, goalId: goal.goalId, expectedVersion: goal.version };
  return <div className="goal-autonomy-controls">
    <h3>自主推进</h3>
    <details className="productivity-configuration">
    <summary>验收标准与自主推进配置</summary>
    <label>验收标准（每行一条，最多 32 条）<textarea aria-label="目标验收标准" value={criteria} disabled={active}
      onChange={event => draft.edit({ ...draft.value, criteria: event.target.value })} placeholder="例如：实际页面通过交互验证，重启后状态保持" /></label>
    <label>截止时间<input aria-label="自主推进截止时间" type="datetime-local" value={deadline} disabled={active} onChange={event => draft.edit({ ...draft.value, deadline: event.target.value })} /></label>
    <label>最大并发<input aria-label="目标最大并发" type="number" min={1} max={16} value={concurrency} disabled={active}
      onChange={event => draft.edit({ ...draft.value, concurrency: Number(event.target.value) })} /></label>
    {draft.conflict && <RevisionDraftConflict subject="自主推进配置" changes={[
      `当前验收标准：${autonomy?.criteria.join('；') || '尚未设置'}`,
      `当前截止时间：${autonomy?.deadlineAt ?? '尚未设置'}；当前最大并发：${autonomy?.maxConcurrency ?? 4}`
    ]} reload={draft.reload} rebase={() => draft.rebase()} />}
    <p>轮次和截止时间限制执行；权限、用户问题和恢复决策仍须在任务会话中处理。</p>
    </details>
    {autonomy && <><p role="status" data-goal-autonomy-status={autonomy.status}>{labels[autonomy.status]} · 已执行 {goal.roundsUsed}/{goal.roundCap} 轮 · 规划/验收 {autonomy.plannerAttempts} 次</p>
      {autonomy.summary && <p>{autonomy.summary}</p>}
      {autonomy.completedBy === 'user' && <p>用户标记完成，未进行自主验收。</p>}
      {autonomy.completedBy === 'verification' && autonomy.assessment && <ol aria-label="目标逐项验收结果">
        {[...autonomy.assessment].sort((left, right) => left.criterion - right.criterion).map(check => <li key={check.criterion}>
          <strong>通过：{autonomy.criteria[check.criterion]}</strong><p>{check.evidence}</p>
        </li>)}
      </ol>}
      {autonomy.sessionId && <button type="button" onClick={() => openSession(autonomy.sessionId!)}>查看规划与验收会话</button>}
      {autonomy.status === 'stopping' && <p>正在等待规划和执行任务确认结束；需要恢复决策时，请打开对应任务会话处理。</p>}
    </>}
    {!active && <><button type="button" disabled={!valid || draft.conflict || hasRunningWorkflow || goal.roundsUsed >= goal.roundCap}
      onClick={() => run(async () => { await productivity.startGoalAutonomy({ ...scope, criteria: items, maxConcurrency: concurrency,
        deadlineAt: new Date(deadline).toISOString() }); draft.committed(); })}>{autonomy ? '重新规划' : '开始自主推进'}</button>
      {!valid && <p>展开配置，设置验收标准、截止时间和并发后可开始。</p>}
      {hasRunningWorkflow && <p>工作流仍在执行，请等待结束后再开始自主推进。</p>}
      {goal.roundsUsed >= goal.roundCap && <p>已达到轮次上限，请在目标配置中调整。</p>}</>}
    {autonomy && ['planning', 'executing', 'verifying'].includes(autonomy.status) && <button type="button"
      onClick={() => run(() => productivity.transitionGoalAutonomy({ ...scope, action: 'pause' }))}>暂停自主推进</button>}
    {autonomy && ['paused', 'blocked'].includes(autonomy.status) && <button type="button"
      disabled={new Date(autonomy.deadlineAt).getTime() <= Date.now()}
      onClick={() => run(() => productivity.transitionGoalAutonomy({ ...scope, action: 'resume' }))}>继续自主推进</button>}
    {autonomy && ['paused', 'blocked'].includes(autonomy.status) && new Date(autonomy.deadlineAt).getTime() <= Date.now()
      && <p>截止时间已过，请修改配置后重新规划。</p>}
  </div>;
}

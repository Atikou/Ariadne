import type { ProductivityFeatureStore, ProductivityGoal } from '@renderer/core/runtime/features/productivity-feature-store';
import { SelectMenu } from '@renderer/shared/ui/SelectMenu';
import { GoalAutonomyControls } from './GoalAutonomyControls';
import { RevisionDraftConflict } from '@renderer/shared/ui/RevisionDraftConflict';
import { autonomyIsActive, goalStatusText } from './ProductivityPresentation';
import { useRevisionDraft } from '@renderer/shared/ui/useRevisionDraft';

export function ProductivityGoalEditor({ goal, workspaceId, sessionId, productivity, hasRunningWorkflow, run, onGoal, openSession }: {
  goal: ProductivityGoal | null; workspaceId: string; sessionId: string; productivity: ProductivityFeatureStore;
  hasRunningWorkflow: boolean; run(operation: () => Promise<unknown>): void;
  onGoal(goal: ProductivityGoal): void; openSession(sessionId: string): void;
}): React.JSX.Element {
  const draft = useRevisionDraft({ title: goal?.title ?? '', status: goal?.status ?? 'active', roundCap: goal?.roundCap ?? 32 },
    JSON.stringify([goal?.goalId ?? null, goal?.version ?? null]));
  const active = autonomyIsActive(goal);
  const valid = draft.value.title.trim().length > 0 && draft.value.title.trim().length <= 2000
    && Number.isInteger(draft.value.roundCap) && draft.value.roundCap >= 1 && draft.value.roundCap <= 10000;
  return <article className="productivity-card productivity-goal">
    <h2>{goal ? '目标与进度' : '建立目标'}</h2>
    {goal && <><strong className="productivity-goal-title">{goal.title}</strong>
      <p role="status">{goalStatusText[goal.status]} · 已执行 {goal.roundsUsed} 轮</p>
    </>}
    <details className="productivity-configuration" open={!goal}>
      <summary>编辑目标与执行配置</summary>
      <label>目标<input aria-label="目标" value={draft.value.title} disabled={active} maxLength={2000}
        onChange={event => draft.edit({ ...draft.value, title: event.target.value })} placeholder="希望完成什么" /></label>
      <SelectMenu<ProductivityGoal['status']> ariaLabel="目标状态" value={draft.value.status}
        onChange={status => draft.edit({ ...draft.value, status })} disabled={goal?.autonomy !== undefined}
        options={(Object.keys(goalStatusText) as ProductivityGoal['status'][]).map(value => ({ value, label: goalStatusText[value] }))} />
      <label>执行轮次上限<input aria-label="目标执行轮次上限" type="number" min={1} max={10000} value={draft.value.roundCap} disabled={active}
        onChange={event => draft.edit({ ...draft.value, roundCap: Number(event.target.value) })} /></label>
      {draft.conflict && <RevisionDraftConflict subject="目标" changes={[
        `原目标：${draft.baseline.title || '尚未建立'}；当前目标：${goal?.title ?? '已删除'}`,
        `当前状态：${goal ? goalStatusText[goal.status] : '无目标'}；当前轮次上限：${goal?.roundCap ?? 32}`
      ]} reload={draft.reload} rebase={() => draft.rebase()} />}
      {active && <p>自主推进期间不能修改目标配置。请先暂停并等待任务结束。</p>}
      <button type="button" disabled={!valid || active || draft.conflict} onClick={() => run(async () => {
        const saved = await productivity.putGoal({ workspaceId, sessionId, goalId: goal?.goalId ?? crypto.randomUUID(),
          expectedVersion: goal?.version ?? null, ...draft.value, title: draft.value.title.trim(), phase: goal?.phase ?? 'active' });
        draft.committed(); onGoal(saved);
      })}>保存目标</button>
      {!valid && <p>填写目标，轮次上限须为 1 至 10000 的整数。</p>}
      {goal && <details><summary>版本与诊断信息</summary><small>目标版本 {goal.version} · 阶段 {goal.phase}</small></details>}
    </details>
    {goal && <details className="productivity-autonomy" open={goal.autonomy !== undefined}>
      <summary>自主推进</summary>
      <GoalAutonomyControls key={goal.goalId} goal={goal} productivity={productivity} hasRunningWorkflow={hasRunningWorkflow}
        run={run} openSession={openSession} />
    </details>}
  </article>;
}

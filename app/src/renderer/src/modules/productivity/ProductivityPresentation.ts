import type { ProductivityGoal, ProductivitySchedule, ProductivitySnapshot, ProductivityWorkflow } from '@renderer/core/runtime/features/productivity-feature-store';
import { PublicResultError } from '@renderer/core/runtime/public-result';

export type ProductivityTodo = ProductivitySnapshot['todos'][number];
export const goalStatusText: Record<ProductivityGoal['status'], string> = {
  active: '进行中', paused: '已暂停', blocked: '需要处理阻塞', complete: '已完成'
};
export const todoStatusText: Record<ProductivityTodo['status'], string> = {
  pending: '等待执行', in_progress: '执行中', completed: '已完成', failed: '执行失败', cancelled: '已取消'
};
export const workflowStatusText: Record<ProductivityWorkflow['status'], string> = {
  running: '执行中', cancelling: '正在取消', completed: '已完成', failed: '执行失败', cancelled: '已取消'
};
export const scheduleStatusText: Record<ProductivitySchedule['status'], string> = {
  active: '已启用', paused: '已暂停', cancelled: '已取消', completed: '已结束'
};
export const autonomyStatusText: Record<NonNullable<ProductivityGoal['autonomy']>['status'], string> = {
  planning: '规划中', executing: '执行中', verifying: '验收中', stopping: '停止中', paused: '已暂停', blocked: '受阻', complete: '已完成'
};
export function autonomyIsActive(goal: ProductivityGoal | null | undefined): boolean {
  return Boolean(goal?.autonomy && ['planning', 'executing', 'verifying', 'stopping'].includes(goal.autonomy.status));
}
export function boundWorkflowTodoIds(workflows: readonly ProductivityWorkflow[]): ReadonlySet<string> {
  return new Set(workflows.filter(item => item.status === 'running' || item.status === 'cancelling')
    .flatMap(item => [...item.activeTodoIds, ...item.pendingTodoIds, ...item.results.map(result => result.todoId)]));
}
export function productivityErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '操作未完成，请检查状态后重试。';
  const known: Record<string, string> = {
    goal_version_conflict: '目标已更新。请刷新并比较新版本，本地输入已保留。',
    productivity_version_conflict: '目标、工作流或调度版本已更新。请刷新并比较，本地输入已保留。',
    todo_revision_conflict: '待办已更新。请刷新并比较新版本，本地输入已保留。',
    todo_dependency_invalid: '前置任务不存在或包含自身，请调整依赖。',
    todo_dependency_duplicate: '同一前置任务不能重复选择。',
    todo_dependency_cycle: '这些前置关系形成了循环，请调整依赖。',
    todo_bound_to_running_workflow: '该待办已被运行中的工作流引用。请等待工作流结束后再修改。',
    workflow_dependency_unavailable: '存在尚未完成的前置任务，请一并执行前置任务。',
    workflow_goal_autonomy_owned: '自主推进正在管理任务。请先暂停自主推进。',
    goal_autonomy_configuration_locked: '自主推进期间不能修改目标配置。请先暂停并等待任务结束。',
    goal_round_cap_reached: '已达到目标执行轮次上限，请调整配置后重试。',
    workflow_goal_round_cap_reached: '已达到目标执行轮次上限，请调整配置后重试。',
    goal_deadline_exceeded: '截止时间已过，请调整配置后重新规划。',
    goal_autonomy_resume_required: '该目标已有自主推进记录，请使用继续自主推进。',
    goal_planner_still_active: '规划任务仍在运行，请等待停止确认。',
    goal_workflow_still_active: '工作流仍在执行，请等待结束。',
    workflow_goal_unavailable: '目标当前不可执行，请检查目标状态。',
    workflow_budget_insufficient: '工作流的执行额度不足以覆盖选中的待办。',
    schedule_occurrence_retry_unavailable: '此提交当前不能重试，请刷新调度状态。'
  };
  const code = error instanceof PublicResultError ? error.publicError.code
    : Object.keys(known).find(value => message === value || message.endsWith(':' + value));
  return (code ? known[code] : undefined) ?? message;
}

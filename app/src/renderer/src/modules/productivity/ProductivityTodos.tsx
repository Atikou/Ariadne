import { useState } from 'react';
import type { ProductivitySnapshot } from '@renderer/core/runtime/features/productivity-feature-store';
import { RevisionDraftConflict } from '@renderer/shared/ui/RevisionDraftConflict';
import { ProductivityTodoDialog, todoSnapshotDifference, todoSnapshotKey, type TodoReplacement } from './ProductivityTodoDialog';
import { autonomyIsActive, boundWorkflowTodoIds, todoStatusText } from './ProductivityPresentation';
import { useRevisionDraft } from '@renderer/shared/ui/useRevisionDraft';

export function ProductivityTodos({ snapshot, busy, replace, run, startWorkflow }: {
  snapshot: ProductivitySnapshot; busy: boolean; replace(base: ProductivitySnapshot, items: TodoReplacement): Promise<void>;
  run(operation: () => Promise<unknown>): void; startWorkflow(): void;
}): React.JSX.Element {
  const [dialog, setDialog] = useState<{ mode: 'edit' | 'delete'; todoId: string } | null>(null);
  const draft = useRevisionDraft({ title: '', dependencies: [] as string[], snapshot }, todoSnapshotKey(snapshot));
  const bound = boundWorkflowTodoIds(snapshot.workflows);
  const autonomyActive = autonomyIsActive(snapshot.goal);
  const pending = snapshot.todos.filter(item => item.status === 'pending');
  const running = snapshot.workflows.some(item => item.status === 'running' || item.status === 'cancelling');
  const reason = !snapshot.goal ? '先建立目标。' : autonomyActive ? '自主推进正在管理待办，请先暂停并等待任务结束。'
    : snapshot.goal.status !== 'active' ? '先将目标恢复为进行中。' : running ? '已有工作流在执行，请等待结束。'
      : pending.length === 0 ? '没有等待执行的待办。' : null;
  const missing = draft.value.dependencies.some(id => !snapshot.todos.some(item => item.todoId === id));
  return <article className="productivity-card productivity-todos">
    <div className="productivity-section-heading"><h2>待办与下一步</h2><span>{snapshot.todos.filter(item => item.status === 'completed').length}/{snapshot.todos.length} 已完成</span></div>
    <ol className="productivity-todo-list" aria-label="待办列表">{snapshot.todos.map(todo => <li key={todo.todoId} data-todo-id={todo.todoId}>
      <div className="productivity-todo-copy"><strong>{todo.title}</strong><span>{todoStatusText[todo.status]}</span>
        {!!todo.dependsOn?.length && <small>前置：{todo.dependsOn.map(id => snapshot.todos.find(item => item.todoId === id)?.title ?? '已不存在的任务').join('、')}</small>}
      </div>
      <div className="productivity-actions">
        <button type="button" disabled={bound.has(todo.todoId) || autonomyActive} onClick={() => setDialog({ mode: 'edit', todoId: todo.todoId })}>编辑</button>
        <button type="button" disabled={bound.has(todo.todoId) || autonomyActive} onClick={() => setDialog({ mode: 'delete', todoId: todo.todoId })}>删除</button>
      </div>
      {bound.has(todo.todoId) && <small>运行中的工作流已冻结此任务，结束后可修改。</small>}
    </li>)}</ol>
    {snapshot.todos.length === 0 && <p>添加待办后，可以启动工作流逐项执行。</p>}
    <div className="productivity-actions"><button type="button" disabled={reason !== null} onClick={startWorkflow}>启动工作流</button></div>
    {reason && <p className="productivity-action-reason">{reason}</p>}
    <p>前置任务完成并写入真实结果后，后续任务才会执行。权限、用户问题和恢复决策请在任务会话中处理。</p>
    <details className="productivity-configuration" open={snapshot.todos.length === 0}>
      <summary>添加待办</summary>
      <div className="productivity-inline"><input aria-label="新增待办" value={draft.value.title} maxLength={2000} disabled={autonomyActive}
        onChange={event => draft.edit({ ...draft.value, title: event.target.value })} placeholder="下一项需要完成什么" />
        <button type="button" disabled={!snapshot.goal || !draft.value.title.trim() || autonomyActive || draft.conflict || missing} onClick={() => run(async () => {
          const base = draft.value.snapshot;
          await replace(base, [...base.todos.map(({ ordinal: _ordinal, ...todo }) => todo),
            { todoId: crypto.randomUUID(), title: draft.value.title.trim(), status: 'pending', dependsOn: [...draft.value.dependencies] }]);
          draft.reload();
        })}>添加</button>
      </div>
      {(snapshot.todos.length > 0 || missing) && <fieldset className="productivity-dependencies" disabled={autonomyActive}><legend>新增待办的前置任务</legend>
        {snapshot.todos.map(todo => <label key={todo.todoId}><input type="checkbox" checked={draft.value.dependencies.includes(todo.todoId)}
          onChange={event => draft.edit({ ...draft.value, dependencies: event.target.checked ? [...draft.value.dependencies, todo.todoId]
            : draft.value.dependencies.filter(id => id !== todo.todoId) })} />{todo.title}</label>)}
        {draft.value.dependencies.filter(id => !snapshot.todos.some(item => item.todoId === id)).map(id => <label key={id}>
          <input type="checkbox" checked onChange={() => draft.edit({ ...draft.value, dependencies: draft.value.dependencies.filter(item => item !== id) })} />
          已删除的前置任务，请取消选择
        </label>)}
      </fieldset>}
      {draft.conflict && <RevisionDraftConflict subject="新增待办" changes={todoSnapshotDifference(draft.value.snapshot, snapshot)}
        reload={draft.reload} rebase={() => draft.rebase((local, current) => ({ ...local, snapshot: current.snapshot }))} />}
      {missing && <p role="alert">选择的前置任务已被删除，请取消该依赖后再添加。</p>}
      {autonomyActive && <p>自主推进正在管理待办，请先暂停并等待任务结束。</p>}
    </details>
    {dialog && <ProductivityTodoDialog key={JSON.stringify(dialog)} {...dialog} snapshot={snapshot} busy={busy}
      replace={replace} run={run} close={() => setDialog(null)} />}
  </article>;
}

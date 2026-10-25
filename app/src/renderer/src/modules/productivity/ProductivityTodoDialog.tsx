import { useId, useRef, useState } from 'react';
import type { ProductivitySnapshot } from '@renderer/core/runtime/features/productivity-feature-store';
import { ModalSurface } from '@renderer/shared/ui/ModalSurface';
import { RevisionDraftConflict } from '@renderer/shared/ui/RevisionDraftConflict';
import { boundWorkflowTodoIds, productivityErrorText } from './ProductivityPresentation';

export type TodoReplacement = readonly Omit<ProductivitySnapshot['todos'][number], 'ordinal'>[];
export function todoSnapshotKey(snapshot: ProductivitySnapshot): string {
  return JSON.stringify([snapshot.goal?.goalId, snapshot.goal?.version, snapshot.todoRevision]);
}
export function todoSnapshotDifference(before: ProductivitySnapshot, after: ProductivitySnapshot): string[] {
  const changes: string[] = [];
  for (const item of before.todos) {
    const current = after.todos.find(value => value.todoId === item.todoId);
    if (!current) changes.push(`已删除：${item.title}`);
    else if (JSON.stringify(item) !== JSON.stringify(current)) changes.push(`已更新：${item.title} → ${current.title}`);
  }
  for (const item of after.todos) if (!before.todos.some(value => value.todoId === item.todoId)) changes.push(`已新增：${item.title}`);
  if (before.goal?.version !== after.goal?.version) changes.push(`目标版本已从 ${before.goal?.version ?? '无'} 更新至 ${after.goal?.version ?? '无'}`);
  return changes.length ? changes : ['待办修订已改变，请确认当前状态。'];
}

export function ProductivityTodoDialog({ mode, todoId, snapshot, busy, replace, run, close }: {
  mode: 'edit' | 'delete'; todoId: string; snapshot: ProductivitySnapshot; busy: boolean;
  replace(base: ProductivitySnapshot, items: TodoReplacement): Promise<void>;
  run(operation: () => Promise<unknown>): void; close(): void;
}): React.JSX.Element {
  const [base, setBase] = useState(snapshot);
  const [initial] = useState(() => snapshot.todos.find(item => item.todoId === todoId)!);
  const original = base.todos.find(item => item.todoId === todoId) ?? initial;
  const current = snapshot.todos.find(item => item.todoId === todoId);
  const [title, setTitle] = useState(original.title);
  const [dependencies, setDependencies] = useState([...(original.dependsOn ?? [])]);
  const [removeEdges, setRemoveEdges] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId(), descriptionId = useId();
  const inputRef = useRef<HTMLInputElement>(null), cancelRef = useRef<HTMLButtonElement>(null);
  const conflict = todoSnapshotKey(base) !== todoSnapshotKey(snapshot);
  const dependents = base.todos.filter(item => item.dependsOn?.includes(todoId));
  const bound = boundWorkflowTodoIds(snapshot.workflows);
  const locked = bound.has(todoId) || (mode === 'delete' && dependents.some(item => bound.has(item.todoId)));
  const missing = dependencies.some(id => !base.todos.some(item => item.todoId === id));
  const valid = !!current && !conflict && !locked && !busy && !missing && !!title.trim() && title.trim().length <= 2000
    && (mode !== 'delete' || dependents.length === 0 || removeEdges);
  const reload = (): void => {
    setBase(snapshot); setRemoveEdges(false); setError(null);
    if (current) { setTitle(current.title); setDependencies([...(current.dependsOn ?? [])]); }
  };
  return <ModalSurface open onClose={() => { if (!busy) close(); }} className="action-dialog-backdrop"
    labelledBy={titleId} describedBy={descriptionId} initialFocusRef={mode === 'edit' ? inputRef : cancelRef}>
    <form className="action-dialog productivity-todo-dialog" onSubmit={event => {
      event.preventDefault(); if (!valid) return;
      const items = base.todos.filter(item => mode !== 'delete' || item.todoId !== todoId).map(({ ordinal: _ordinal, ...item }) =>
        mode === 'edit' && item.todoId === todoId ? { ...item, title: title.trim(), dependsOn: dependencies }
          : mode === 'delete' && removeEdges ? { ...item, dependsOn: item.dependsOn?.filter(id => id !== todoId) ?? [] } : item);
      run(async () => { try { await replace(base, items); close(); }
        catch (failure) { setError(productivityErrorText(failure)); throw failure; } });
    }}>
      <h2 id={titleId}>{mode === 'edit' ? '编辑待办' : '删除待办'}</h2>
      <p id={descriptionId}>{mode === 'edit' ? '修改标题和前置任务，执行结果仍由任务所有者确认。' : `将删除“${original.title}”。已启动工作流引用的任务不能修改。`}</p>
      {mode === 'edit' && <>
        <label>待办标题<input ref={inputRef} aria-label="待办编辑标题" value={title} maxLength={2000} disabled={busy || locked}
          onChange={event => setTitle(event.target.value)} /></label>
        <fieldset className="productivity-dependencies" disabled={busy || locked}><legend>前置任务</legend>
          {base.todos.filter(item => item.todoId !== todoId).map(item => <label key={item.todoId}>
            <input type="checkbox" checked={dependencies.includes(item.todoId)} onChange={event => setDependencies(value => event.target.checked
              ? [...value, item.todoId] : value.filter(id => id !== item.todoId))} />{item.title}
          </label>)}
          {base.todos.length === 1 && <p>暂无可选前置任务。</p>}
          {dependencies.filter(id => !base.todos.some(item => item.todoId === id)).map(id => <label key={id}>
            <input type="checkbox" checked onChange={() => setDependencies(value => value.filter(item => item !== id))} />
            已删除的前置任务，请取消选择
          </label>)}
        </fieldset>
      </>}
      {mode === 'delete' && dependents.length > 0 && <section aria-label="删除依赖影响">
        <p>以下待办引用了这个前置任务：</p><ul>{dependents.map(item => <li key={item.todoId}>{item.title}</li>)}</ul>
        <label><input type="checkbox" checked={removeEdges} disabled={busy || locked}
          onChange={event => setRemoveEdges(event.target.checked)} />同时解除以上前置关系。部分任务可能因此不再需要等待此任务。</label>
      </section>}
      {!current && <p role="alert">该待办已被删除。本地编辑内容仍可复制。</p>}
      {locked && <p role="status">任务或引用它的任务已被运行中的工作流冻结，请等待工作流结束。</p>}
      {conflict && <RevisionDraftConflict subject="待办" changes={todoSnapshotDifference(base, snapshot)} reload={reload}
        rebase={() => { setBase(snapshot); setRemoveEdges(false); setError(null); }} />}
      {missing && <p role="alert">本地选择的前置任务已不存在，请重新选择。</p>}
      {error && <p role="alert">{error}</p>}
      <footer><button ref={cancelRef} type="button" disabled={busy} onClick={close}>取消</button>
        <button type="submit" className={mode === 'delete' ? 'danger-button' : 'primary-button'} disabled={!valid}>
          {mode === 'edit' ? '保存待办' : dependents.length ? '解除依赖并删除' : '确认删除待办'}
        </button></footer>
    </form>
  </ModalSurface>;
}

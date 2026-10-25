import { useEffect, useState } from 'react';
import { PERSONAL_ASSISTANT_WORKSPACE_ID, type TaskCenterFilter } from '@ariadne/protocol/public';
import type { ModuleServices } from '@renderer/core/modules/module-services-contract';
import type { ConversationWorkspace } from '@renderer/core/conversations/conversation-navigation-service';
import { taskSourceLabels, taskStateLabels } from './task-center-presentation';
import { SelectMenu } from '@renderer/shared/ui/SelectMenu';

interface Props {
  services: Pick<ModuleServices, 'conversationNavigation' | 'tasks'>;
  filter: TaskCenterFilter;
  session: { workspaceId: string; sessionId: string } | null;
}
const sources = Object.keys(taskSourceLabels) as TaskCenterFilter['sources'];
const states = Object.keys(taskStateLabels) as TaskCenterFilter['states'];
function dateValue(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function TaskCenterFilters({ services, filter, session }: Props): React.JSX.Element {
  const [workspaces, setWorkspaces] = useState<readonly ConversationWorkspace[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const update = (rows: readonly ConversationWorkspace[]) => { if (alive) setWorkspaces(rows); };
    const unsubscribe = services.conversationNavigation.onWorkspacesChanged(update);
    void services.conversationNavigation.listWorkspaces().then(update).catch(() => { if (alive) setError('工作区目录暂时不可用。'); });
    return () => { alive = false; unsubscribe(); };
  }, [services.conversationNavigation]);
  const apply = (patch: Partial<TaskCenterFilter>) => {
    const next = { ...filter, ...patch, reference: null };
    if (next.updatedFrom && next.updatedThrough && next.updatedFrom > next.updatedThrough) { setError('起始时间不能晚于结束时间。'); return; }
    setError(null); void services.tasks.setFilter(next);
  };
  return <div className="task-center-filters">
    <label>范围<SelectMenu ariaLabel="任务范围" value={filter.sessionId ? 'session' : filter.workspaceId ?? 'all'} onChange={value => {
      if (value === 'session' && session) apply(session);
      else apply({ workspaceId: value === 'all' ? null : value, sessionId: null });
    }} options={[
      { value: 'all', label: '全部可访问工作区' },
      ...(session || filter.sessionId ? [{ value: 'session', label: '当前会话' }] : []),
      { value: PERSONAL_ASSISTANT_WORKSPACE_ID, label: '个人助手' },
      ...workspaces.map(workspace => ({ value: workspace.workspaceId, label: `${workspace.name}${workspace.archivedAt ? '（已归档）' : ''}` })),
      ...(filter.workspaceId && filter.workspaceId !== PERSONAL_ASSISTANT_WORKSPACE_ID && !workspaces.some(row => row.workspaceId === filter.workspaceId)
        ? [{ value: filter.workspaceId, label: `工作区 #${filter.workspaceId.slice(-8)}` }] : [])
    ]} /></label>
    <label>来源<SelectMenu ariaLabel="任务来源" value={filter.sources.length === 1 ? filter.sources[0]! : 'all'}
      onChange={value => apply({ sources: value === 'all' ? sources : [value as TaskCenterFilter['sources'][number]] })}
      options={[{ value: 'all', label: '全部来源' }, ...sources.map(source => ({ value: source, label: taskSourceLabels[source] }))]} /></label>
    <label>状态<SelectMenu ariaLabel="任务状态筛选" value={filter.states[0] ?? 'all'}
      onChange={value => apply({ states: value === 'all' ? [] : [value as TaskCenterFilter['states'][number]] })}
      options={[{ value: 'all', label: '全部状态' }, ...states.map(state => ({ value: state, label: taskStateLabels[state] }))]} /></label>
    <details className="task-center-more-filters"><summary>时间与归档</summary><div>
      <label>更新起始<input type="date" aria-label="任务更新起始日期" value={dateValue(filter.updatedFrom)} onChange={event => apply({ updatedFrom: event.target.value ? new Date(`${event.target.value}T00:00:00`).toISOString() : null })} /></label>
      <label>更新结束<input type="date" aria-label="任务更新结束日期" value={dateValue(filter.updatedThrough)} onChange={event => apply({ updatedThrough: event.target.value ? new Date(`${event.target.value}T23:59:59.999`).toISOString() : null })} /></label>
      <label className="task-center-checkbox"><input type="checkbox" checked={filter.includeArchived} onChange={event => apply({ includeArchived: event.target.checked })} />包含归档会话</label>
    </div></details>
    {filter.sessionId && <p className="task-center-note">固定会话 #{filter.sessionId.slice(-8)}；切换会话后可重新选择“当前会话”。</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ListChecks, RotateCw } from 'lucide-react';
import { taskReferenceKey, type TaskCenterNavigation, type TaskDirectoryRow } from '@ariadne/protocol/public';
import { useFeatureSnapshot } from '@renderer/core/runtime/features/feature-snapshot-store';
import type { FeaturePanelProps } from '@renderer/core/modules/module-contract';
import { StatusPill } from '@renderer/shared/ui/StatusPill';
import { usePanelAction } from '@renderer/shared/ui/usePanelAction';
import { TaskCenterFilters } from './TaskCenterFilters';
import { TaskCenterDetail } from './TaskCenterDetail';
import { openTaskCenterTarget } from '@renderer/core/conversations/task-center-navigation';
import { taskDisplayTitle, taskSourceLabels, taskStateLabels, taskStatusTone } from './task-center-presentation';
import './task-center.css';
import { TaskNotificationPreferences } from './TaskNotificationPreferences';

export function TaskCenterPanel({ services }: FeaturePanelProps): React.JSX.Element {
  const view = useFeatureSnapshot(services.tasks.view);
  const [showPreferences, setShowPreferences] = useState(false);
  const sessions = useFeatureSnapshot(services.sessions.view);
  const scroll = useRef<HTMLDivElement>(null);
  const initialScroll = useRef(view.scrollTop);
  const { pending, error, execute } = usePanelAction();
  const selectedSession = sessions.sessions.find(row => row.sessionId === sessions.selectedSessionId);
  useEffect(() => {
    if (!services.tasks.view.getSnapshot().page && !services.tasks.view.getSnapshot().loading) void services.tasks.refresh(false);
  }, [services.tasks]);
  useEffect(() => {
    if (view.pageNumber !== 1 || view.loading || !view.page?.watermarks.some(row => row.status === 'building')) return;
    const timer = setTimeout(() => { void services.tasks.refresh(false); }, 2000);
    return () => clearTimeout(timer);
  }, [services.tasks, view.page, view.pageNumber, view.loading]);
  useLayoutEffect(() => { if (scroll.current) scroll.current.scrollTop = initialScroll.current; }, []);
  useLayoutEffect(() => { if (scroll.current && view.scrollTop === 0) scroll.current.scrollTop = 0; }, [view.scrollTop]);
  const navigate = (row: TaskDirectoryRow, destination: TaskCenterNavigation['destination'], decision?: TaskDirectoryRow['decisions'][number]) => {
    void execute(async () => {
      const initialSession = services.sessions.view.getSnapshot().selectedSessionId;
      const initialWorkspace = services.conversationNavigation.getSelectedWorkspaceId();
      const result = await services.tasks.requestNavigation(row, destination, decision);
      if (services.sessions.view.getSnapshot().selectedSessionId !== initialSession
        || services.conversationNavigation.getSelectedWorkspaceId() !== initialWorkspace) return;
      if (result?.status === 'ok') await openTaskCenterTarget(services, result);
    });
  };
  const related = (relation: TaskDirectoryRow['metadata']['relations'][number]) => {
    void execute(async () => {
      const selectedKey = services.tasks.view.getSnapshot().selectedKey;
      const row = await services.tasks.lookup(relation.reference, relation.owner.workspaceId, relation.owner.sessionId);
      if (services.tasks.view.getSnapshot().selectedKey !== selectedKey) return;
      if (!row) throw new Error('关联记录尚未同步、已移除或不可访问，请刷新后重试。');
      services.tasks.select(row);
    });
  };
  return <section className="task-center-panel" aria-label="任务中心">
    <header className="task-center-header"><div><ListChecks size={17} /><h1>任务中心</h1></div>
      <button aria-expanded={showPreferences} onClick={() => setShowPreferences(value => !value)}>提醒设置</button>
      <button disabled={view.loading || pending} onClick={() => void services.tasks.refresh()}><RotateCw size={13} />刷新</button>
    </header>
    {showPreferences && <TaskNotificationPreferences preferences={services.preferences} />}
    <TaskCenterFilters services={services} filter={view.filter} session={selectedSession ? { workspaceId: selectedSession.workspaceId, sessionId: selectedSession.sessionId } : null} />
    <div className="task-center-coverage" role="status">
      {view.page ? <><span>{view.page.complete ? '来源已同步' : '部分来源尚未就绪'} · 按更新时间排序</span>
        <span>本次目录 {view.page.indexedTotal} 项 · 第 {view.pageNumber} 页</span>
        <span>采集于 {new Date(view.page.capturedAt).toLocaleTimeString()}；各来源可能稍有延迟。</span>
        {!view.page.complete && <span>{view.page.watermarks.filter(row => row.status !== 'ready').map(row => `${row.source}: ${row.status === 'building' ? '同步中' : '不可用'}`).join(' · ')}</span>}</>
        : <span>{view.loading ? '正在读取任务目录…' : '任务目录尚未加载'}</span>}
    </div>
    {(error || view.error) && <p className="task-center-feedback" role="alert">{error ?? view.error}</p>}
    <div className="task-center-content" ref={scroll} onScroll={event => services.tasks.rememberScroll(event.currentTarget.scrollTop)}>
      <ul className="task-center-list" aria-label="任务目录" aria-busy={view.loading}>
        {view.page?.rows.map(row => <li key={taskReferenceKey(row.metadata.reference)}><button className="task-center-row" data-task-key={taskReferenceKey(row.metadata.reference)} aria-current={view.selectedKey === taskReferenceKey(row.metadata.reference)} onClick={() => services.tasks.select(row)}>
          <span className="task-center-row-heading"><strong>{taskDisplayTitle(row)}</strong><StatusPill tone={taskStatusTone(row.metadata.state)}>{taskStateLabels[row.metadata.state]}</StatusPill></span>
          <span>{taskSourceLabels[row.metadata.reference.source]} #{row.metadata.reference.sourceId.slice(-8)} · 会话 #{row.metadata.sessionId.slice(-8)}{row.archived ? ' · 已归档' : ''}</span>
          <span className="task-center-row-meta">{row.metadata.updatedAt ? new Date(row.metadata.updatedAt).toLocaleString() : '更新时间未知'}{row.decisions.length > 0 ? ` · ${row.decisions.length} 项待确认` : ''}</span>
        </button></li>)}
      </ul>
      {view.page?.rows.length === 0 && <p className="task-center-note">{view.page.complete ? '此范围没有任务记录。' : '此范围尚无已同步记录，可稍后刷新。'}</p>}
      {view.selected && <TaskCenterDetail row={view.selected} tasks={services.tasks} pending={pending || view.navigating} onNavigate={(destination, decision) => navigate(view.selected!, destination, decision)} onRelated={related} />}
      {!view.selected && view.page && view.page.rows.length > 0 && <p className="task-center-note">选择任务查看来源、关联和导航入口。</p>}
    </div>
    <footer className="task-center-pager"><button disabled={view.loading || !view.hasPrevious} onClick={() => void services.tasks.navigatePage('previous')}>上一页</button>
      <span>第 {view.pageNumber} 页</span><button disabled={view.loading || !view.page?.nextCursor} onClick={() => void services.tasks.navigatePage('next')}>下一页</button>
      {view.releasedPrevious && <span className="task-center-note">更早页已释放，可刷新返回目录首页。</span>}
    </footer>
  </section>;
}

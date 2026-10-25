import type { PublicRunCatalogSummary } from '@ariadne/protocol/public';
import type { FeaturePanelProps } from '@renderer/core/modules/module-contract';
import { useFeatureSnapshot } from '@renderer/core/runtime/features/feature-snapshot-store';
import { formatRunStatus } from '@renderer/core/runtime/runtime-labels';
import { ProjectionCatalogPager } from '@renderer/shared/ui/ProjectionCatalogPager';
import { StatusPill } from '@renderer/shared/ui/StatusPill';
import { usePanelAction } from '@renderer/shared/ui/usePanelAction';
import { runStatusTone } from './agent-status-model';

function runTitle(run: PublicRunCatalogSummary, identity: string): string {
  // These are the publisher's public placeholders, not a task objective.
  // Identify such tasks by their real stable ID; never fetch private prompts.
  return run.title === 'Agent run' ? `Agent 任务 #${identity}`
    : run.title === 'SubAgent task' ? `子任务 #${identity}` : run.title;
}

export function AgentRunDirectory({ services, scope, openedRunId, onScope }: Pick<FeaturePanelProps, 'services'> & {
  scope: 'all' | 'session'; openedRunId: string | null; onScope(scope: 'all' | 'session'): void;
}): React.JSX.Element {
  const sessions = useFeatureSnapshot(services.sessions.view), runs = useFeatureSnapshot(services.runs.view);
  const action = usePanelAction();
  const window = scope === 'all' ? runs.runDirectory : runs.sessionRunDirectory;
  const rows = window?.page.rows.flatMap(row => row.feature === 'runs' ? [row.dto] : []) ?? [];
  const noSession = scope === 'session' && sessions.selectedSessionId === null;
  return <section className="agent-run-directory" aria-label="任务目录" aria-busy={action.pending}>
    <header><h2>任务目录</h2><div className="agent-directory-scopes" role="group" aria-label="任务目录范围">
      <button type="button" aria-pressed={scope === 'all'} disabled={action.pending} onClick={() => onScope('all')}>全部会话</button>
      <button type="button" aria-pressed={scope === 'session'} disabled={action.pending || sessions.selectedSessionId === null} onClick={() => onScope('session')}>当前会话</button>
    </div></header>
    <p className="agent-directory-description">{scope === 'all' ? '全部会话的任务；选择后打开所属会话与任务详情。' : '当前会话的任务；详情显示所选任务。'}</p>
    <ProjectionCatalogPager key={scope + ':' + (scope === 'session' ? sessions.selectedSessionId : 'all')} window={window}
      navigate={direction => scope === 'all' ? services.runs.navigate(direction) : services.runs.navigateSession(direction)} label="任务" />
    <div className="agent-run-list">
      {noSession ? <p className="agent-directory-empty">请选择一条会话。</p> : window === null ? <p role="status" className="agent-directory-empty">正在读取任务目录…</p>
        : rows.length === 0 ? <p className="agent-directory-empty">{window.page.totalRows === 0 ? (scope === 'all' ? '尚无任务记录。' : '此会话尚无任务记录；全部会话目录可能仍有任务。') : '此页没有任务，请通过分页查看其他记录。'}</p>
        : <ul>{rows.map(row => {
          const session = sessions.sessions.find(candidate => candidate.sessionId === row.sessionId);
          const shortId = row.runId.slice(-8);
          const identity = rows.some(other => other.runId !== row.runId && other.runId.endsWith(shortId)) ? row.runId : shortId;
          const title = runTitle(row, identity), timestamp = row.startedAt ?? row.updatedAt;
          return <li key={row.runId}><button type="button" className="agent-run-row" data-run-id={row.runId}
            aria-current={openedRunId === row.runId ? 'true' : undefined} aria-label={`查看任务：${title}`}
            disabled={action.pending || row.sessionId === undefined} onClick={() => void action.execute(async () => {
              if (row.sessionId === undefined) return;
              await services.sessions.select(row.sessionId);
              // A sidebar change while selection is loading owns the new view.
              if (services.sessions.view.getSnapshot().selectedSessionId !== row.sessionId) return;
              await services.runs.openDetail(row.runId);
            })}>
            <span className="agent-run-heading"><strong title={title}>{title}</strong><StatusPill tone={runStatusTone(row.status)}>{formatRunStatus(row.status)}</StatusPill></span>
            <span className="agent-run-session">会话：{session?.title || `#${row.sessionId?.slice(0, 8) ?? '不可用'}`}</span>
            <span className="agent-run-meta"><time dateTime={timestamp}>{new Date(timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time><span>#{identity} · {openedRunId === row.runId ? '当前详情' : '查看详情'}</span></span>
          </button></li>;
        })}</ul>}
    </div>
    {action.pending && <p role="status" className="agent-directory-feedback">正在打开任务…</p>}
    {action.error && <p role="alert" className="agent-directory-feedback">{action.error}</p>}
  </section>;
}

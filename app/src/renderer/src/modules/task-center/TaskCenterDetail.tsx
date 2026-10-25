import type { TaskCenterNavigation, TaskDirectoryRow } from '@ariadne/protocol/public';
import { StatusPill } from '@renderer/shared/ui/StatusPill';
import { usePanelDetailFocus } from '@renderer/shared/ui/usePanelDetailFocus';
import { taskDisplayTitle, taskSourceLabels, taskStateLabels, taskStatusTone } from './task-center-presentation';
import type { TaskCenterFeatureStore } from '@renderer/core/runtime/features/task-center-feature-store';
import { TaskCenterRelations } from './TaskCenterRelations';

interface Props {
  row: TaskDirectoryRow;
  tasks: TaskCenterFeatureStore;
  pending: boolean;
  onNavigate(destination: TaskCenterNavigation['destination'], decision?: TaskDirectoryRow['decisions'][number]): void;
  onRelated(relation: TaskDirectoryRow['metadata']['relations'][number]): void;
}
export function TaskCenterDetail({ row, tasks, pending, onNavigate, onRelated }: Props): React.JSX.Element {
  const metadata = row.metadata;
  const detail = usePanelDetailFocus(true, `${metadata.reference.source}:${metadata.reference.sourceId}`);
  return <section ref={detail} tabIndex={-1} className="task-center-detail" aria-label="所选任务详情">
    <header><h2 title={taskDisplayTitle(row)}>{taskDisplayTitle(row)}</h2><StatusPill tone={taskStatusTone(metadata.state)}>{taskStateLabels[metadata.state]}</StatusPill></header>
    {taskDisplayTitle(row).length > 100 && <details className="task-center-full-title"><summary>展开完整标题</summary><p>{taskDisplayTitle(row)}</p></details>}
    <dl>
      <div><dt>来源</dt><dd>{taskSourceLabels[metadata.reference.source]} · {metadata.sourceStatus}</dd></div>
      <div><dt>记录 ID</dt><dd>{metadata.reference.sourceId}</dd></div>
      <div><dt>工作区</dt><dd>{metadata.workspaceId}</dd></div>
      <div><dt>会话</dt><dd>{metadata.sessionId}{row.archived ? ' · 已归档' : ''}</dd></div>
      <div><dt>版本</dt><dd>{metadata.version === null ? `触发尝试 ${metadata.attempts}` : `v${metadata.version}`}</dd></div>
      <div><dt>更新时间</dt><dd>{metadata.updatedAt ? new Date(metadata.updatedAt).toLocaleString() : '来源未提供'}</dd></div>
      {metadata.dueAt && <div><dt>触发时间</dt><dd>{new Date(metadata.dueAt).toLocaleString()}</dd></div>}
    </dl>
    {metadata.state === 'unknown' && <p className="task-center-note">尚无已核实的执行状态。请到来源会话查看恢复处理。</p>}
    <div className="task-center-actions">
      <button disabled={pending || row.archived} onClick={() => onNavigate('details')}>{metadata.reference.source === 'run' ? '打开任务详情' : '打开所属会话'}</button>
      {row.result === 'available' && <button disabled={pending || row.archived} onClick={() => onNavigate('result')}>查看结果</button>}
      {row.result === 'pending' && <span className="task-center-note">结果正在同步</span>}
      {['unknown', 'recovering', 'failed', 'blocked'].includes(metadata.state) && <button disabled={pending || row.archived} onClick={() => onNavigate('recovery')}>查看恢复入口</button>}
    </div>
    {row.decisions.length > 0 && <div className="task-center-related"><h3>待确认 · {row.decisions.length}</h3>
      {row.decisions.map(decision => <button key={decision.decisionId} data-decision-id={decision.decisionId} disabled={pending || row.archived} onClick={() => onNavigate('decision', decision)}>
        {decision.kind === 'permission' ? '权限确认' : decision.kind === 'plan' ? '计划确认' : '任务确认'} #{decision.decisionId.slice(-8)} · v{decision.version}
      </button>)}
    </div>}
    <TaskCenterRelations key={`${metadata.reference.source}:${metadata.reference.sourceId}:${metadata.version}:${metadata.attempts}:${metadata.sourceStatus}`} row={row} tasks={tasks} onRelated={onRelated} />
    <div className="task-center-related"><h3>当前已核实运行 · {metadata.runReferences.length} 项</h3>
      {metadata.runReferences.map(run => <button key={run.runId} disabled={pending} onClick={() => onRelated({ reference: { source: 'run', sourceId: run.runId }, owner: { workspaceId: run.workspaceId, sessionId: run.sessionId }, kind: 'execution' })}>
        运行 #{run.runId.slice(-8)} · 会话 #{run.sessionId.slice(-8)}
      </button>)}
      {metadata.runReferences.length === 0 && <p className="task-center-note">当前摘要没有已核实的运行。</p>}
      {metadata.runReferenceTotal > metadata.runReferences.length && <p className="task-center-note">来源关联运行数 {metadata.runReferenceTotal}；可在来源关联分页继续核验。</p>}
    </div>
  </section>;
}

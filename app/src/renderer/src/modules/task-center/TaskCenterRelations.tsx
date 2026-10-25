import { useEffect, useRef, useState } from 'react';
import type { TaskDirectoryRow, TaskCenterRelationsResult } from '@ariadne/protocol/public';
import type { TaskCenterFeatureStore } from '@renderer/core/runtime/features/task-center-feature-store';
import { usePanelAction } from '@renderer/shared/ui/usePanelAction';
import { taskSourceLabels } from './task-center-presentation';

interface Props {
  row: TaskDirectoryRow;
  tasks: TaskCenterFeatureStore;
  onRelated(relation: TaskDirectoryRow['metadata']['relations'][number]): void;
}
/** One relation page and at most 32 positions; Source revision guards every read. */
export function TaskCenterRelations({ row, tasks, onRelated }: Props): React.JSX.Element {
  const [page, setPage] = useState<TaskCenterRelationsResult | null>(null);
  const [positions, setPositions] = useState<number[]>([]);
  const [released, setReleased] = useState(false);
  const alive = useRef(true);
  const action = usePanelAction();
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const first = () => { void action.execute(async () => {
    const result = await tasks.relations(row, 0);
    if (alive.current && result) { setPage(result); setPositions([]); setReleased(false); }
  }); };
  const navigate = (direction: 'next' | 'previous') => { void action.execute(async () => {
    if (!page) return;
    const next = direction === 'next' ? page.nextIndex : positions.at(-1);
    if (next === null || next === undefined) return;
    const result = await tasks.relations(row, next);
    if (!alive.current || !result) return;
    if (direction === 'next') {
      const history = [...positions, page.afterIndex];
      if (history.length > 32) { history.shift(); setReleased(true); }
      setPositions(history);
    } else setPositions(positions.slice(0, -1));
    setPage(result);
  }); };
  const rows = page?.rows ?? row.metadata.relations;
  return <div className="task-center-related"><h3>来源关联 · 本页 {rows.length} 项／来源总数 {page?.sourceTotal ?? row.metadata.relationTotal}</h3>
    <p className="task-center-note">显示可访问的关联；来源总数包含尚未核实或已不可访问的引用。</p>
    {rows.map(relation => <button key={`${relation.kind}:${relation.reference.source}:${relation.reference.sourceId}:${relation.owner.sessionId}`} disabled={action.pending} onClick={() => onRelated(relation)}>
      {taskSourceLabels[relation.reference.source]} #{relation.reference.sourceId.slice(-8)} · {relation.kind}
    </button>)}
    {row.metadata.relationTotal === 0 && <p className="task-center-note">没有关联记录。</p>}
    {row.metadata.reference.source !== 'run' && row.metadata.relationTotal > row.metadata.relations.length && !page
      && <button disabled={action.pending} onClick={first}>浏览全部来源关联</button>}
    {page && <div className="task-center-actions"><button disabled={action.pending || positions.length === 0} onClick={() => navigate('previous')}>上一关联页</button>
      <button disabled={action.pending || page.nextIndex === null} onClick={() => navigate('next')}>下一关联页</button>
      <button disabled={action.pending} onClick={first}>关联首页</button>
    </div>}
    {released && <p className="task-center-note">更早页已释放，可回关联首页。</p>}
    {action.pending && <p role="status">正在读取关联…</p>}{action.error && <p role="alert">{action.error}</p>}
  </div>;
}

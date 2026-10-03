import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, FileCode2, GitBranch, Minus, Plus, RotateCcw } from 'lucide-react';
import type { FeaturePanelProps } from '@renderer/core/modules/module-contract';
import { useFeatureSnapshot } from '@renderer/core/runtime/features/feature-snapshot-store';
import type {
  ReviewDetailState,
  ReviewEvent,
  ReviewFileChange,
  ReviewSourceSnapshot
} from '@renderer/core/runtime/features/review-types';
import { ReviewInspector } from './ReviewInspector';
import { SequenceDiagram } from './SequenceDiagram';
import { buildReviewSessionViewModel } from './review-session-model';
import './visual-review.css';

type FileFilter = 'all' | 'created' | 'modified' | 'deleted';

export function VisualReviewPanel({ moduleId, services }: FeaturePanelProps): React.JSX.Element {
  const sessions = useFeatureSnapshot(services.sessions.view);
  const messages = useFeatureSnapshot(services.messages.view);
  const runs = useFeatureSnapshot(services.runs.view);
  const source = useMemo<ReviewSourceSnapshot>(() => ({
    selectedSessionId: sessions.selectedSessionId,
    sessions: sessions.sessions,
    messages: messages.messages,
    runs: runs.runs,
    activities: runs.activities
  }), [messages.messages, runs.activities, runs.runs, sessions.selectedSessionId, sessions.sessions]);
  const [details, setDetails] = useState<ReadonlyMap<string, ReviewDetailState>>(() => new Map());
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FileFilter>('all');
  const [scale, setScale] = useState(100);

  useEffect(() => {
    setDetails(new Map());
    setSelectedEventId(null);
    setFilter('all');
  }, [source.selectedSessionId]);

  const fileChangesByEvent = useMemo(() => new Map(
    [...details.entries()].flatMap(([eventId, state]) => (
      state.status === 'ready' && state.detail.fileChanges.length > 0
        ? [[eventId, state.detail.fileChanges] as const]
        : []
    ))
  ), [details]);
  const view = useMemo(
    () => buildReviewSessionViewModel(source, fileChangesByEvent),
    [fileChangesByEvent, source]
  );
  const selectedEvent = view.events.find((event) => event.id === selectedEventId) ?? view.events[0];
  const selectedDetail = selectedEvent === undefined
    ? { status: 'idle' as const }
    : details.get(selectedEvent.id) ?? { status: 'idle' as const };
  const visibleFiles = filter === 'all'
    ? view.files
    : view.files.filter((file) => file.changeKind === filter);
  const changedLines = view.files.reduce((total, file) => total + file.additions + file.deletions, 0);

  useEffect(() => {
    if (selectedEventId !== null && view.events.some((event) => event.id === selectedEventId)) return;
    setSelectedEventId(view.events[0]?.id ?? null);
  }, [selectedEventId, view.events]);

  const loadDetail = async (event: ReviewEvent): Promise<void> => {
    if (!event.detailAvailable || event.activityId === undefined || event.runId === undefined || view.session === null) return;
    setDetails((current) => new Map(current).set(event.id, { status: 'loading' }));
    try {
      const result = await services.toolResults.loadDetail(
        event.runId,
        view.session.workspaceId,
        event.activityId
      );
      const fileChanges = parseFileChanges(result.content, event);
      setDetails((current) => new Map(current).set(event.id, {
        status: 'ready',
        detail: {
          eventId: event.id,
          runId: event.runId!,
          activityId: event.activityId!,
          digest: result.digest,
          totalBytes: result.totalBytes,
          presentationKind: event.presentationKind ?? result.presentation.kind,
          status: result.status,
          fileChanges,
          rawPreview: result.content.slice(0, 32_768),
          complete: result.complete
        }
      }));
    } catch (error) {
      setDetails((current) => new Map(current).set(event.id, {
        status: 'error',
        message: error instanceof Error ? error.message : '无法读取工具详情。'
      }));
    }
  };

  if (view.session === null) {
    return <section className="visual-review-panel" aria-labelledby={`${moduleId}-title`}>
      <div className="visual-review-empty"><FileCode2 size={22} /><h1 id={`${moduleId}-title`}>会话变更审查</h1><p>选择一个会话后，这里会显示真实的消息、运行、工具调用和文件变更时序。</p></div>
    </section>;
  }

  return <section className="visual-review-panel" aria-labelledby={`${moduleId}-title`}>
    <header className="visual-review-header">
      <div className="visual-review-heading">
        <span>VISUAL REVIEW</span>
        <h1 id={`${moduleId}-title`}>会话变更审查</h1>
        <p>{view.session.title} · {view.session.sessionId}</p>
      </div>
      <dl className="review-session-stats">
        <div><dt>事件</dt><dd>{view.events.length}</dd></div>
        <div><dt>文件</dt><dd>{view.files.length}</dd></div>
        <div><dt>变更行</dt><dd>{changedLines}</dd></div>
        <div><dt>更新</dt><dd>{formatTime(view.session.updatedAt)}</dd></div>
      </dl>
      <div className="review-zoom" aria-label="时序图缩放">
        <button type="button" aria-label="缩小" disabled={scale <= 80} onClick={() => setScale((value) => Math.max(80, value - 10))}><Minus size={13} /></button>
        <button type="button" className="review-zoom-value" onClick={() => setScale(100)}>{scale}%</button>
        <button type="button" aria-label="放大" disabled={scale >= 120} onClick={() => setScale((value) => Math.min(120, value + 10))}><Plus size={13} /></button>
        <button type="button" aria-label="重置缩放" onClick={() => setScale(100)}><RotateCcw size={13} /></button>
      </div>
    </header>

    <div className="visual-review-demo-banner visual-review-live-banner" role="status">
      <CheckCircle2 size={14} />
      <strong>真实会话数据</strong>
      <span>消息、Run 和工具活动来自当前 Public Projection；工具详情按需读取。</span>
      <code>{view.session.workspaceId}</code>
    </div>

    <div className="visual-review-workspace">
      <aside className="review-file-sidebar" aria-label="本次会话涉及文件">
        <header><div><FileCode2 size={14} /><strong>已发现文件</strong></div><span>{view.files.length}</span></header>
        <div className="review-file-filters">
          {([
            ['all', '全部'], ['created', '新增'], ['modified', '修改'], ['deleted', '删除']
          ] as const).map(([id, label]) => <button type="button" className={filter === id ? 'is-active' : ''} key={id} onClick={() => setFilter(id)}>{label}</button>)}
        </div>
        <div className="review-file-list">
          {visibleFiles.map((file) => <button type="button" className={file.eventIds.includes(selectedEvent?.id ?? '') ? 'is-active' : ''} key={file.path} onClick={() => setSelectedEventId(file.eventIds.at(-1) ?? null)}>
            <span className={`review-file-status review-file-status--${file.changeKind === 'created' ? 'created' : 'modified'}`}>{file.changeKind === 'created' ? 'A' : file.changeKind === 'deleted' ? 'D' : 'M'}</span>
            <span><strong>{basename(file.path)}</strong><small>{dirname(file.path)}</small></span>
            <span className="review-file-delta"><i>+{file.additions}</i><em>-{file.deletions}</em></span>
          </button>)}
          {visibleFiles.length === 0 && <p className="review-file-empty">打开有文件变更的工具事件后，文件会显示在这里。</p>}
        </div>
        <footer><GitBranch size={12} /><span>{view.session.workspaceId}</span><small>Projection</small></footer>
      </aside>

      <SequenceDiagram actors={view.actors} events={view.events} selectedEventId={selectedEvent?.id ?? ''} scale={scale} onSelect={setSelectedEventId} />
      {selectedEvent
        ? <ReviewInspector event={selectedEvent} detail={selectedDetail} onLoadDetail={() => { void loadDetail(selectedEvent); }} />
        : <aside className="review-inspector review-inspector-empty"><FileCode2 size={20} /><span>本次会话暂无事件。</span></aside>}
    </div>

    <footer className="review-live-footer">时序仅展示当前会话可公开的 Projection 信息；受保护工具结果不会自动复制到会话历史。</footer>
  </section>;
}

function parseFileChanges(content: string, event: ReviewEvent): ReviewFileChange[] {
  if (event.presentationKind !== 'file_change') return [];
  let value: unknown;
  try { value = JSON.parse(content) as unknown; } catch { return []; }
  const record = isRecord(value) ? value : null;
  const nested = record && isRecord(record.result) ? record.result : null;
  const values = record && Array.isArray(record.fileChanges)
    ? record.fileChanges
    : nested && Array.isArray(nested.fileChanges)
      ? nested.fileChanges
    : record && Array.isArray(record.changes)
      ? record.changes
      : nested && Array.isArray(nested.changes)
        ? nested.changes
        : record && typeof record.path === 'string' ? [record]
          : nested && typeof nested.path === 'string' ? [nested] : [];
  return values.flatMap((item) => {
    if (!isRecord(item) || typeof item.path !== 'string') return [];
    const changeKind = item.changeKind === 'created' || item.changeKind === 'deleted' || item.changeKind === 'moved_from' || item.changeKind === 'moved_to' || item.changeKind === 'observed'
      ? item.changeKind
      : 'modified';
    return [{
      path: item.path,
      changeKind,
      additions: integer(item.additions) ?? integer(item.added) ?? 0,
      deletions: integer(item.deletions) ?? integer(item.removed) ?? 0,
      ...(typeof item.diff === 'string' ? { diff: item.diff } : {}),
      diffTruncated: item.diffTruncated === true,
      summary: typeof item.summary === 'string' ? item.summary : '工具报告的文件变更'
    }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function basename(path: string): string { return path.split(/[\\/]/u).at(-1) ?? path; }
function dirname(path: string): string { const parts = path.split(/[\\/]/u); parts.pop(); return parts.join('/'); }
function formatTime(value: string): string { return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

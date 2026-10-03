import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronRight, Clock3, LoaderCircle, TerminalSquare, X } from 'lucide-react';
import type { RunActivity } from '@ariadne/protocol/public';
import { useFeatureSnapshot } from '@renderer/core/runtime/features/feature-snapshot-store';
import type { ProtectedToolResultDetail } from '@renderer/core/runtime/features/tool-result-feature-store';
import { formatActivityKind } from '@renderer/core/runtime/runtime-labels';
import type { FeaturePanelProps } from '@renderer/core/modules/module-contract';
import { PanelEmptyState } from '@renderer/shared/ui/PanelEmptyState';
import './tool-output.css';

interface LoadedDetail {
  readonly metadata: ProtectedToolResultDetail;
  readonly content: string;
}

export function ToolOutputPanel({ moduleId, services }: FeaturePanelProps): React.JSX.Element {
  const sessions = useFeatureSnapshot(services.sessions.view);
  const selectedSession = sessions.sessions.find(session => session.sessionId === sessions.selectedSessionId);
  return <SessionToolOutputPanel
    key={sessions.selectedSessionId ?? 'no-session'}
    moduleId={moduleId}
    services={services}
    sessionId={sessions.selectedSessionId ?? undefined}
    workspaceId={selectedSession?.workspaceId}
  />;
}

function SessionToolOutputPanel({ moduleId, services, sessionId, workspaceId }: FeaturePanelProps & {
  sessionId: string | undefined;
  workspaceId: string | undefined;
}): React.JSX.Element {
  const runView = useFeatureSnapshot(services.runs.view);
  const [selected, setSelected] = useState<LoadedDetail | null>(null);
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const detailHeadingRef = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => () => { requestGeneration.current += 1; }, []);
  useEffect(() => { if (selectedActivityId) detailHeadingRef.current?.focus(); }, [selectedActivityId]);
  const sessionRunIds = new Set(
    runView.runs
      .filter((run) => run.sessionId === sessionId)
      .map((run) => run.runId)
  );
  const activities = runView.activities
    .filter((activity): activity is Extract<RunActivity, { activityType: 'tool' }> =>
      activity.activityType === 'tool' && sessionRunIds.has(activity.runId))
    .slice(-50)
    .reverse();

  const openDetail = async (
    activity: Extract<RunActivity, { activityType: 'tool' }>
  ): Promise<void> => {
    if (
      workspaceId === undefined
      || !activity.detailAvailable
      || !['completed', 'failed'].includes(activity.status)
    ) return;
    const generation = ++requestGeneration.current;
    setSelectedActivityId(activity.activityId);
    setSelected(null);
    setLoadingId(activity.activityId);
    setError(null);
    try {
      const detail = await services.toolResults.loadDetail(
        activity.runId,
        workspaceId,
        activity.activityId
      );
      if (generation === requestGeneration.current) setSelected({ metadata: detail, content: detail.content });
    } catch (cause) {
      if (generation === requestGeneration.current) setError(cause instanceof Error ? cause.message : '无法读取受保护工具结果。');
    } finally {
      if (generation === requestGeneration.current) setLoadingId(null);
    }
  };

  const loadMore = async (): Promise<void> => {
    if (selected === null || selected.metadata.complete || loadingId !== null) return;
    const generation = ++requestGeneration.current;
    setLoadingId(selected.metadata.effectId);
    setError(null);
    try {
      const next = await services.toolResults.loadDetail(
        selected.metadata.runId,
        selected.metadata.workspaceId,
        selected.metadata.effectId,
        selected.metadata.nextCursor
      );
      if (
        next.digest !== selected.metadata.digest
        || next.cursor !== selected.metadata.nextCursor
        || next.presentation.kind !== selected.metadata.presentation.kind
      ) throw new Error('protected_tool_result_page_drift');
      if (generation === requestGeneration.current) setSelected({ metadata: next, content: `${selected.content}${next.content}` });
    } catch (cause) {
      if (generation === requestGeneration.current) setError(cause instanceof Error ? cause.message : '无法继续读取受保护工具结果。');
    } finally {
      if (generation === requestGeneration.current) setLoadingId(null);
    }
  };

  return <section className="tool-output-panel" aria-labelledby={`${moduleId}-title`}>
    <header><h1 id={`${moduleId}-title`}>工具输出</h1><span>最近 {activities.length} 次调用</span></header>
    <div className={`tool-output-body${selectedActivityId ? ' has-detail' : ''}`}>
    <div className="tool-call-table" aria-label="工具调用列表">
      {activities.map((activity) => <button
        type="button"
        className={`tool-call-row is-${activity.status}`}
        key={activity.activityId}
        ref={element => { if (element) rowRefs.current.set(activity.activityId, element); else rowRefs.current.delete(activity.activityId); }}
        disabled={!activity.detailAvailable || !['completed', 'failed'].includes(activity.status) || loadingId !== null}
        aria-expanded={selectedActivityId === activity.activityId}
        onClick={() => { void openDetail(activity); }}
      >
        {activity.status === 'failed' ? <X size={15} /> : activity.status === 'completed' ? <Check size={15} /> : activity.status === 'running' ? <LoaderCircle size={15} className="tool-call-spinner" /> : <Clock3 size={15} />}
        <div className="tool-call-copy"><strong>{activity.title}</strong><span>{activity.summary ?? formatActivityKind(activity)}</span></div>
        <time dateTime={activity.occurredAt}>{new Date(activity.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
        <ChevronRight size={13} />
      </button>)}
      {activities.length === 0 && <PanelEmptyState compact icon={TerminalSquare} title="暂无工具调用" description={sessionId ? '此会话的工具调用和结果会显示在这里。' : '选择一条会话，查看它的工具调用和结果。'} />}
    </div>
    {selectedActivityId && <section className="tool-output-detail" aria-label="工具结果详情" aria-busy={loadingId !== null}>
      <header><button ref={detailHeadingRef} type="button" className="tool-detail-back" onClick={() => {
        requestGeneration.current += 1;
        const previous = selectedActivityId;
        setSelectedActivityId(null);
        setSelected(null);
        setLoadingId(null);
        setError(null);
        requestAnimationFrame(() => rowRefs.current.get(previous)?.focus());
      }}><ArrowLeft size={14} /> 返回调用列表</button></header>
      <div className="tool-detail-scroll">
        {error && <p className="tool-result-detail-error" role="alert">{error}</p>}
        {loadingId && !selected && <p className="tool-result-loading" role="status">正在读取工具结果…</p>}
        {selected && <ProtectedResultCard detail={selected} loading={loadingId !== null} onLoadMore={loadMore} />}
      </div>
    </section>}
    </div>
  </section>;
}

function ProtectedResultCard({
  detail,
  loading,
  onLoadMore
}: {
  readonly detail: LoadedDetail;
  readonly loading: boolean;
  readonly onLoadMore: () => Promise<void>;
}): React.JSX.Element {
  const parsed = detail.metadata.complete ? parseJson(detail.content) : null;
  return <article className="tool-result-detail-card" data-presentation-kind={detail.metadata.presentation.kind}>
    <header>
      <div><strong>{detail.metadata.presentation.label}</strong><span>{detail.metadata.status === 'failed' ? '失败' : '完成'}</span></div>
      <small>{formatBytes(detail.metadata.totalBytes)} · {detail.metadata.digest.slice(0, 18)}…</small>
    </header>
    <ProtectedResultBody kind={detail.metadata.presentation.kind} value={parsed} raw={detail.content} />
    {!detail.metadata.complete && <button type="button" disabled={loading} onClick={() => { void onLoadMore(); }}>
      {loading ? '正在读取…' : '继续读取'}
    </button>}
  </article>;
}

export function ProtectedResultBody({
  kind,
  value,
  raw
}: {
  readonly kind: ProtectedToolResultDetail['presentation']['kind'];
  readonly value: unknown;
  readonly raw: string;
}): React.JSX.Element {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (kind === 'file_read' && typeof record.content === 'string') {
      return <><p>{String(record.path ?? '文件')}</p><pre>{record.content}</pre></>;
    }
    if ((kind === 'terminal' || kind === 'command') && (
      typeof record.stdout === 'string'
      || typeof record.stderr === 'string'
      || Array.isArray(record.chunks)
    )) {
      const chunks = Array.isArray(record.chunks)
        ? record.chunks.filter(isTerminalChunk)
        : [];
      return <>
        {typeof record.stdout === 'string' && record.stdout.length > 0 && <pre>{record.stdout}</pre>}
        {typeof record.stderr === 'string' && record.stderr.length > 0 && <pre className="is-stderr">{record.stderr}</pre>}
        {chunks.length > 0 && <pre>{chunks.map((chunk) => chunk.text).join('')}</pre>}
      </>;
    }
    if (kind === 'file_search') {
      const hits = searchHits(record);
      return hits.length === 0
        ? <p>没有匹配项。</p>
        : <ol className="tool-result-search-hits">{hits.map((hit, index) => <li key={`${hit.path}:${String(hit.line)}:${String(index)}`}>
          <code>{hit.path}{hit.line > 0 ? `:${String(hit.line)}:${String(hit.column)}` : ''}</code>
          {hit.preview.length > 0 && <pre>{hit.preview}</pre>}
        </li>)}</ol>;
    }
    if (kind === 'file_change') {
      if (typeof record.diff === 'string' && record.diff.length > 0) {
        return <><p>{String(record.path ?? record.destinationPath ?? '文件变更')}</p><pre className="tool-result-diff">{record.diff}</pre></>;
      }
      return <dl>{Object.entries(record).slice(0, 16).map(([key, item]) => <div key={key}><dt>{key}</dt><dd>{scalar(item)}</dd></div>)}</dl>;
    }
  }
  return <pre>{value === null ? raw : JSON.stringify(value, null, 2)}</pre>;
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

function scalar(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : JSON.stringify(value) ?? String(value);
}

interface SearchHit {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly preview: string;
}

function searchHits(record: Record<string, unknown>): readonly SearchHit[] {
  const nested = isRecord(record.result) ? record.result : record;
  const values = Array.isArray(nested.matches)
    ? nested.matches
    : Array.isArray(nested.items)
      ? nested.items
      : [];
  return values.flatMap((value): SearchHit[] => {
    if (!isRecord(value) || typeof value.path !== 'string') return [];
    const range = isRecord(value.range) && isRecord(value.range.start)
      ? value.range.start
      : null;
    return [{
      path: value.path,
      line: integer(value.line) ?? integer(range?.line) ?? 0,
      column: integer(value.column) ?? integer(range?.column) ?? 0,
      preview: typeof value.preview === 'string'
        ? value.preview
        : typeof value.name === 'string'
          ? value.name
          : ''
    }];
  });
}

function isTerminalChunk(value: unknown): value is { readonly text: string } {
  return isRecord(value) && typeof value.text === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integer(value: unknown): number | null {
  return Number.isSafeInteger(value) ? Number(value) : null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

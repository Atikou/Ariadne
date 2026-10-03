import { useState } from 'react';
import {
  Braces,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  FileCode2,
  LoaderCircle,
  Wrench
} from 'lucide-react';
import type {
  ReviewDetailState,
  ReviewEvent,
  ReviewFileChange
} from '@renderer/core/runtime/features/review-types';

interface ReviewInspectorProps {
  readonly event: ReviewEvent;
  readonly detail: ReviewDetailState;
  onLoadDetail(): void;
}

export function ReviewInspector({ event, detail, onLoadDetail }: ReviewInspectorProps): React.JSX.Element {
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(new Set());
  const fileChanges = detail.status === 'ready' ? detail.detail.fileChanges : [];
  const toggleFile = (path: string): void => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return <aside className="review-inspector" aria-label="事件审查详情">
    <header>
      <div className={`review-inspector-kicker review-inspector-kicker--${event.status}`}>
        {event.status === 'running' ? <LoaderCircle className="is-spinning" size={13} /> : event.status === 'completed' ? <CheckCircle2 size={13} /> : <Clock3 size={13} />}
        {eventStatusLabel(event.status)} · {formatTime(event.occurredAt)}
      </div>
      <h2>{event.title}</h2>
      <p>{event.summary}</p>
      {event.detailAvailable && <button type="button" onClick={onLoadDetail} disabled={detail.status === 'loading'}>
        <Wrench size={13} />{detail.status === 'loading' ? '正在读取详情…' : '读取工具详情'}
      </button>}
    </header>

    <section className="review-inspector-section">
      <h3><Braces size={12} />事件信息</h3>
      <dl className="review-event-facts">
        <div><dt>类型</dt><dd>{eventKindLabel(event.kind)}</dd></div>
        {event.toolName && <div><dt>工具</dt><dd>{event.toolName}</dd></div>}
        {event.durationMs !== undefined && <div><dt>耗时</dt><dd>{formatDuration(event.durationMs)}</dd></div>}
      </dl>
      {detail.status === 'error' && <p className="review-detail-error" role="alert">{detail.message}</p>}
    </section>

    <section className="review-inspector-section review-change-section">
      <h3><FileCode2 size={12} />文件变更</h3>
      {fileChanges.length > 0
        ? fileChanges.map((file) => <FileDiff
            key={`${file.path}:${file.changeKind}`}
            file={file}
            expanded={expandedPaths.has(file.path)}
            onToggle={() => toggleFile(file.path)}
          />)
        : detail.status === 'ready' && detail.detail.rawPreview
          ? <pre className="review-detail-preview">{detail.detail.rawPreview}</pre>
          : <div className="review-no-change"><FileCode2 size={17} /><span>{event.presentationKind === 'file_change' ? '未解析到文件变更详情' : '此事件没有文件变更'}</span></div>}
    </section>
  </aside>;
}

function FileDiff({ file, expanded, onToggle }: {
  readonly file: ReviewFileChange;
  readonly expanded: boolean;
  onToggle(): void;
}): React.JSX.Element {
  return <article className="review-file-diff">
    <button type="button" aria-expanded={expanded} onClick={onToggle}>
      {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      <span className={`review-file-status review-file-status--${file.changeKind === 'created' ? 'created' : 'modified'}`}>
        {file.changeKind === 'created' ? 'A' : file.changeKind === 'deleted' ? 'D' : 'M'}
      </span>
      <span><code>{file.path}</code><small>{file.summary}</small></span>
      <strong><i>+{file.additions}</i><em>-{file.deletions}</em></strong>
    </button>
    {expanded && <div className="review-diff-body" role="region" aria-label={`${file.path} 差异`}>
      {file.diff ? <pre className="review-detail-preview">{file.diff}</pre> : <p>当前没有可显示的文本差异。</p>}
    </div>}
  </article>;
}

function eventStatusLabel(status: ReviewEvent['status']): string {
  return { pending: '等待中', running: '进行中', completed: '已完成', failed: '失败', skipped: '已跳过' }[status];
}

function eventKindLabel(kind: ReviewEvent['kind']): string {
  return {
    message: '消息', run_started: '运行开始', run_finished: '运行结束',
    subagent_started: '子代理开始', subagent_finished: '子代理结束', tool: '工具调用', system: '系统事件'
  }[kind];
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDuration(value: number): string {
  if (value < 1_000) return `${String(value)} ms`;
  return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)} s`;
}

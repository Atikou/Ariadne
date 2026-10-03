import type { CSSProperties } from 'react';
import {
  Bot,
  Check,
  FileCode2,
  ShieldCheck,
  UserRound,
  Wrench
} from 'lucide-react';
import type { ReviewActor, ReviewEvent } from '@renderer/core/runtime/features/review-types';

const actorIcons = { user: UserRound, agent: Bot, subagent: Bot, tool: Wrench, workspace: FileCode2, runtime: ShieldCheck } as const;

interface SequenceDiagramProps {
  readonly actors: readonly ReviewActor[];
  readonly events: readonly ReviewEvent[];
  readonly selectedEventId: string;
  readonly scale: number;
  onSelect(eventId: string): void;
}

export function SequenceDiagram({
  actors,
  events,
  selectedEventId,
  scale,
  onSelect
}: SequenceDiagramProps): React.JSX.Element {
  const actorColumns = new Map<string, number>(
    actors.map((actor, index) => [actor.id, index + 2])
  );
  return <section className="review-sequence" aria-label="本次会话时序图">
    <header className="review-sequence-title">
      <div><strong>完整时序</strong><span>{events.length} 个会话事件</span></div>
      <div className="review-sequence-legend">
        <span><i className="is-message" />消息</span>
        <span><i className="is-file" />工具调用</span>
        <span><i className="is-verify" />系统事件</span>
      </div>
    </header>
    <div className="review-sequence-scroll">
      <div
        className="review-sequence-board"
        style={{ '--review-scale': String(scale / 100) } as CSSProperties}
      >
        <div className="review-participants">
          <span className="review-time-heading">时间</span>
          {actors.map((actor) => {
            const Icon = actorIcons[actor.kind];
            return <div className="review-participant" key={actor.id}>
              <span><Icon size={15} /></span>
              <strong>{actor.name}</strong>
              <small>{actor.role}</small>
            </div>;
          })}
        </div>
        <div className="review-lifelines" aria-hidden="true">
          <span />{actors.map((actor) => <i key={actor.id} />)}
        </div>
        <ol className="review-event-list">
          {events.map((event, index) => {
            const fromColumn = actorColumns.get(event.from) ?? 2;
            const toColumn = actorColumns.get(event.to) ?? 2;
            const startColumn = Math.min(fromColumn, toColumn);
            const endColumn = Math.max(fromColumn, toColumn);
            return <li className="review-event-row" key={event.id}>
              <time><strong>{formatTime(event.occurredAt)}</strong><small>{event.durationMs === undefined ? '' : `+${formatDuration(event.durationMs)}`}</small></time>
              <button
                type="button"
                className={`review-event-route review-event-route--${event.kind}${selectedEventId === event.id ? ' is-selected' : ''}`}
                data-direction={fromColumn <= toColumn ? 'forward' : 'backward'}
                style={{ gridColumn: `${String(startColumn)} / ${String(endColumn + 1)}` }}
                aria-pressed={selectedEventId === event.id}
                onClick={() => onSelect(event.id)}
              >
                <span className="review-route-line"><i /><b /></span>
                <span className="review-event-card">
                  <span className="review-event-number">{String(index + 1).padStart(2, '0')}</span>
                  <span className="review-event-copy"><strong>{event.title}</strong><small>{event.summary}</small></span>
                  <span className="review-event-meta">
                    {event.status === 'completed' ? <><Check size={11} /> 已完成</> : event.status === 'running' ? '进行中' : event.status === 'failed' ? '失败' : '已跳过'}
                    {event.presentationKind === 'file_change' && <em>文件变更</em>}
                  </span>
                </span>
              </button>
            </li>;
          })}
        </ol>
      </div>
    </div>
  </section>;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDuration(value: number): string {
  if (value < 1_000) return `${String(value)}ms`;
  return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}s`;
}

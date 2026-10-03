import type { RunActivity } from '@ariadne/protocol/public';
import type { RuntimeMessage, RuntimeRun } from '@renderer/core/runtime/runtime-projection-presenter';
import type {
  ReviewActor,
  ReviewEvent,
  ReviewEventStatus,
  ReviewFileChange,
  ReviewFileSummary,
  ReviewSourceSnapshot
} from '@renderer/core/runtime/features/review-types';

export interface ReviewSessionViewModel {
  readonly session: ReviewSourceSnapshot['sessions'][number] | null;
  readonly actors: readonly ReviewActor[];
  readonly events: readonly ReviewEvent[];
  readonly files: readonly ReviewFileSummary[];
}

export function buildReviewSessionViewModel(
  source: ReviewSourceSnapshot,
  fileChangesByEvent: ReadonlyMap<string, readonly ReviewFileChange[]> = new Map()
): ReviewSessionViewModel {
  const session = source.sessions.find((item) => item.sessionId === source.selectedSessionId) ?? null;
  if (session === null) return { session: null, actors: [], events: [], files: [] };

  const messages = source.messages.filter((message) => message.sessionId === session.sessionId);
  const runs = source.runs.filter((run) => run.sessionId === session.sessionId);
  const runIds = new Set(runs.map((run) => run.runId));
  const activities = source.activities.filter((activity) => runIds.has(activity.runId));
  const childRuns = runs.filter((run) => run.parentRunId !== undefined);
  const actors: ReviewActor[] = [
    { id: 'user', kind: 'user', name: '你', role: '用户' },
    { id: 'agent', kind: 'agent', name: '主 Agent', role: '当前会话' },
    { id: 'tools', kind: 'tool', name: '工具', role: '工作区操作' },
    { id: 'runtime', kind: 'runtime', name: 'Runtime', role: '系统事件' },
    ...childRuns.map((run) => ({
      id: actorIdForRun(run),
      kind: 'subagent' as const,
      name: run.subagentProviderId ?? 'SubAgent',
      role: '子代理'
    }))
  ];
  const events = [
    ...messages.map(messageEvent),
    ...runs.map(runEvent),
    ...activities.map((activity) => activityEvent(activity, runs))
  ].sort(compareEvents);
  return {
    session,
    actors,
    events,
    files: collectReviewFiles(events, fileChangesByEvent)
  };
}

function messageEvent(message: RuntimeMessage): ReviewEvent {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  return {
    id: `message:${message.messageId}`,
    sessionId: message.sessionId,
    occurredAt: message.createdAt,
    from: isUser ? 'user' : isSystem ? 'runtime' : 'agent',
    to: isUser ? 'agent' : 'user',
    title: isUser ? '用户消息' : isSystem ? '系统消息' : 'Agent 回复',
    summary: summarize(message.content),
    kind: 'message',
    status: statusForMessage(message.status),
    messageId: message.messageId,
    detailAvailable: false
  };
}

function runEvent(run: RuntimeRun): ReviewEvent {
  const completed = ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status);
  return {
    id: `run:${run.runId}`,
    sessionId: run.sessionId ?? '',
    occurredAt: run.completedAt ?? run.startedAt ?? new Date(0).toISOString(),
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
    ...(run.startedAt === undefined || run.completedAt === undefined ? {} : {
      durationMs: Math.max(0, Date.parse(run.completedAt) - Date.parse(run.startedAt))
    }),
    from: 'agent',
    to: run.parentRunId === undefined ? 'tools' : actorIdForRun(run),
    title: run.userFacingLabel,
    summary: run.title,
    kind: completed ? 'run_finished' : 'run_started',
    status: statusForRun(run.status),
    runId: run.runId,
    detailAvailable: false
  };
}

function activityEvent(activity: RunActivity, runs: readonly RuntimeRun[]): ReviewEvent {
  const run = runs.find((candidate) => candidate.runId === activity.runId);
  if (activity.activityType === 'system') {
    return {
      id: `activity:${activity.activityId}`,
      sessionId: run?.sessionId ?? '',
      occurredAt: activity.occurredAt,
      ...(activity.startedAt === undefined ? {} : { startedAt: activity.startedAt }),
      ...(activity.completedAt === undefined ? {} : { completedAt: activity.completedAt }),
      ...(activity.durationMs === undefined ? {} : { durationMs: activity.durationMs }),
      from: 'runtime',
      to: 'agent',
      title: activity.title,
      summary: activity.summary ?? 'Runtime 系统活动',
      kind: 'system',
      status: statusForActivity(activity.status),
      runId: activity.runId,
      activityId: activity.activityId,
      detailAvailable: false
    };
  }
  return {
    id: `activity:${activity.activityId}`,
    sessionId: run?.sessionId ?? '',
    occurredAt: activity.occurredAt,
    ...(activity.startedAt === undefined ? {} : { startedAt: activity.startedAt }),
    ...(activity.completedAt === undefined ? {} : { completedAt: activity.completedAt }),
    ...(activity.durationMs === undefined ? {} : { durationMs: activity.durationMs }),
    from: run?.parentRunId === undefined ? 'agent' : actorIdForRun(run),
    to: 'tools',
    title: activity.title,
    summary: activity.summary ?? activity.toolName,
    kind: 'tool',
    status: statusForActivity(activity.status),
    runId: activity.runId,
    activityId: activity.activityId,
    toolName: activity.toolName,
    ...(activity.presentationKind === undefined ? {} : { presentationKind: activity.presentationKind }),
    detailAvailable: activity.detailAvailable
  };
}

export function collectReviewFiles(
  events: readonly ReviewEvent[],
  fileChangesByEvent: ReadonlyMap<string, readonly ReviewFileChange[]>
): readonly ReviewFileSummary[] {
  const files = new Map<string, ReviewFileSummary>();
  for (const event of events) {
    for (const file of fileChangesByEvent.get(event.id) ?? []) {
      const previous = files.get(file.path);
      files.set(file.path, {
        path: file.path,
        changeKind: file.changeKind,
        additions: (previous?.additions ?? 0) + file.additions,
        deletions: (previous?.deletions ?? 0) + file.deletions,
        eventIds: [...(previous?.eventIds ?? []), event.id]
      });
    }
  }
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function actorIdForRun(run: Pick<RuntimeRun, 'runId' | 'parentRunId'>): string {
  return run.parentRunId === undefined ? 'agent' : `subagent:${run.runId}`;
}

function compareEvents(left: ReviewEvent, right: ReviewEvent): number {
  return Date.parse(left.occurredAt) - Date.parse(right.occurredAt)
    || left.id.localeCompare(right.id);
}

function summarize(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized || '空消息';
}

function statusForMessage(status: RuntimeMessage['status']): ReviewEventStatus {
  if (status === 'streaming') return 'running';
  if (status === 'failed') return 'failed';
  if (status === 'interrupted') return 'skipped';
  return 'completed';
}

function statusForRun(status: RuntimeRun['status']): ReviewEventStatus {
  if (['completed'].includes(status)) return 'completed';
  if (['failed'].includes(status)) return 'failed';
  if (['cancelled', 'interrupted'].includes(status)) return 'skipped';
  return 'running';
}

function statusForActivity(status: RunActivity['status']): ReviewEventStatus {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'skipped') return 'skipped';
  if (status === 'running') return 'running';
  return 'pending';
}

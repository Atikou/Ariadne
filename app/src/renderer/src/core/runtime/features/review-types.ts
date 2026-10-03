import type { RuntimeMessage, RuntimeRun } from '../runtime-projection-presenter';

export type ReviewActorKind =
  | 'user'
  | 'agent'
  | 'subagent'
  | 'tool'
  | 'workspace'
  | 'runtime';

export interface ReviewActor {
  readonly id: string;
  readonly kind: ReviewActorKind;
  readonly name: string;
  readonly role: string;
}

export type ReviewEventKind =
  | 'message'
  | 'run_started'
  | 'run_finished'
  | 'subagent_started'
  | 'subagent_finished'
  | 'tool'
  | 'system';

export type ReviewEventStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface ReviewEvent {
  readonly id: string;
  readonly sessionId: string;
  readonly occurredAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly from: string;
  readonly to: string;
  readonly title: string;
  readonly summary: string;
  readonly kind: ReviewEventKind;
  readonly status: ReviewEventStatus;
  readonly runId?: string;
  readonly activityId?: string;
  readonly messageId?: string;
  readonly toolName?: string;
  readonly presentationKind?:
    | 'generic'
    | 'file_read'
    | 'file_search'
    | 'file_change'
    | 'command'
    | 'terminal'
    | 'browser'
    | 'skill'
    | 'external';
  readonly detailAvailable: boolean;
}

export type ReviewFileChangeKind =
  | 'created'
  | 'modified'
  | 'deleted'
  | 'moved_from'
  | 'moved_to'
  | 'observed';

export interface ReviewFileChange {
  readonly path: string;
  readonly changeKind: ReviewFileChangeKind;
  readonly additions: number;
  readonly deletions: number;
  readonly diff?: string;
  readonly diffTruncated: boolean;
  readonly summary: string;
}

export interface ReviewEventDetail {
  readonly eventId: string;
  readonly runId: string;
  readonly activityId: string;
  readonly digest: string;
  readonly totalBytes: number;
  readonly presentationKind: NonNullable<ReviewEvent['presentationKind']>;
  readonly status: 'succeeded' | 'failed';
  readonly fileChanges: readonly ReviewFileChange[];
  readonly resultSummary?: string;
  readonly rawPreview?: string;
  readonly complete: boolean;
}

export type ReviewDetailState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly detail: ReviewEventDetail }
  | { readonly status: 'error'; readonly message: string };

export interface ReviewFileSummary {
  readonly path: string;
  readonly changeKind: ReviewFileChangeKind;
  readonly additions: number;
  readonly deletions: number;
  readonly eventIds: readonly string[];
}

export interface ReviewSessionSnapshot {
  readonly selectedSessionId: string | null;
  readonly session: {
    readonly sessionId: string;
    readonly workspaceId: string;
    readonly title: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  } | null;
  readonly actors: readonly ReviewActor[];
  readonly events: readonly ReviewEvent[];
  readonly details: ReadonlyMap<string, ReviewDetailState>;
  readonly files: readonly ReviewFileSummary[];
  readonly hydrating: boolean;
  readonly hydrationError: string | null;
}

export interface ReviewSourceSnapshot {
  readonly selectedSessionId: string | null;
  readonly sessions: readonly {
    readonly sessionId: string;
    readonly workspaceId: string;
    readonly title: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  }[];
  readonly messages: readonly RuntimeMessage[];
  readonly runs: readonly RuntimeRun[];
  readonly activities: readonly import('@ariadne/protocol/public').RunActivity[];
}

export interface ReviewReferenceSendResult {
  readonly route: 'agent_inbox' | 'conversation_turn';
  readonly referenceCount: number;
  readonly targetRunId?: string;
  readonly messageId?: string;
}

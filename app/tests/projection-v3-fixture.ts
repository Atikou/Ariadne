import { createHash } from 'node:crypto';
import {
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  PUBLIC_PROJECTION_GENESIS_DIGEST,
  PUBLIC_PROJECTION_HISTORY_DOMAIN,
  canonicalPublicProjectionJson,
  publicProjectionCatalogRow,
  type ProjectionCommit,
  type PublicMessageProjection,
  type PublicModelProjection,
  type PublicProjectionChange,
  type PublicProjectionReadBatch,
  type PublicProjectionSnapshot,
  type PublicRunProjection,
  type PublicSessionProjection
} from '@ariadne/protocol/public';
import type { ProjectionRun, ProjectionCollectionCoverage } from '../src/renderer/src/core/runtime/projection/projection-presentation';

export const NOW = '2026-07-31T00:00:00.000Z';

/** Explicit complete DTO fixture -> frontend coverage. Production derives
 * this state from verified document pages; this helper is test-only. */
export function presentationRun(dto: PublicRunProjection): ProjectionRun {
  const row = publicProjectionCatalogRow({ feature: 'runs', aggregateId: dto.runId, aggregateVersion: dto.version, operation: 'upsert', projectedAt: dto.updatedAt, dto });
  if (row.feature !== 'runs') throw new Error('run_fixture_required');
  const coverage = (total: number): ProjectionCollectionCoverage => ({ state: 'complete', total, count: total, startOrdinal: 0, hasEarlier: false, hasMore: false });
  const token = `sha256:${'0'.repeat(64)}`;
  return { ...row.dto, documentToken: token, toolActivities: dto.toolActivities,
    inbox: dto.inbox.map(input => ({ ...input, bodyState: 'loaded', bodyReadToken: token })),
    collections: { toolActivities: coverage(dto.toolActivities.length), inbox: coverage(dto.inbox.length), interactionMessages: coverage(dto.interactionMessages.length) } };
}

export function projectionSnapshot(
  overrides: Partial<PublicProjectionSnapshot> = {}
): PublicProjectionSnapshot {
  return {
    contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
    streamId: 'stream-a',
    cursor: 0,
    cursorDigest: PUBLIC_PROJECTION_GENESIS_DIGEST,
    capturedAt: NOW,
    sessions: [],
    messages: [],
    runs: [],
    decisions: [],
    models: [],
    diagnostics: [],
    inferenceStreams: [],
    tombstones: [],
    ...overrides
  };
}

export function session(
  sessionId: string,
  version = 1
): PublicSessionProjection {
  return {
    sessionId,
    workspaceId: 'workspace-primary',
    version,
    title: `Session ${sessionId}`,
    pinned: false,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW
  };
}

export function message(
  messageId: string,
  sessionId: string,
  version = 1
): PublicMessageProjection {
  return {
    messageId,
    sessionId,
    version,
    role: 'assistant',
    content: `Message ${messageId}`,
    status: 'completed',
    createdAt: NOW,
    updatedAt: NOW
  };
}

export function run(
  runId: string,
  status: PublicRunProjection['status'] = 'running',
  version = 1
): PublicRunProjection {
  return {
    runId,
    sessionId: 'session-a',
    version,
    title: `Run ${runId}`,
    status,
    label: `Run ${status}`,
    toolActivities: [],
    inbox: [],
    interactionMessages: [],
    updatedAt: NOW,
    startedAt: NOW
  };
}

export function model(modelId: string, version = 1): PublicModelProjection {
  return {
    modelId,
    version,
    label: `Model ${modelId}`,
    location: 'local',
    availability: 'ready',
    supportsTextChat: true,
    supportsAgent: true,
    supportsPlan: true,
    supportsVision: false,
    qualificationState: 'qualified',
    updatedAt: NOW
  };
}

export function upsertChange(
  feature: PublicProjectionChange['feature'],
  dto: PublicProjectionChange['dto'] & { version: number },
  aggregateId: string
): PublicProjectionChange {
  return {
    feature,
    operation: 'upsert',
    aggregateId,
    aggregateVersion: dto.version,
    projectedAt: NOW,
    dto
  } as PublicProjectionChange;
}

export function projectionCommit(
  eventId: string,
  changes: readonly PublicProjectionChange[],
  sourceCursor = 1
): ProjectionCommit {
  return {
    contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
    eventId,
    sourceId: 'source-a',
    sourceCursor,
    occurredAt: NOW,
    changes: [...changes]
  };
}

export function readBatch(
  afterCursor: number,
  afterDigest: string,
  commits: readonly ProjectionCommit[],
  options: { streamId?: string; hasMore?: boolean } = {}
): Extract<PublicProjectionReadBatch, { status: 'ok' }> {
  let previous = afterDigest;
  const entries = commits.map((commit, index) => {
    const cursor = afterCursor + index + 1;
    const payloadDigest = digest(canonicalPublicProjectionJson(commit));
    const cursorDigest = digest(
      `${PUBLIC_PROJECTION_HISTORY_DOMAIN}\u0000${previous}`
      + `\u0000${String(cursor)}\u0000${payloadDigest}`
    );
    previous = cursorDigest;
    return { cursor, cursorDigest, commit };
  });
  return {
    status: 'ok',
    contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
    streamId: options.streamId ?? 'stream-a',
    afterCursor,
    afterDigest,
    nextCursor: entries.at(-1)?.cursor ?? afterCursor,
    nextDigest: entries.at(-1)?.cursorDigest ?? afterDigest,
    hasMore: options.hasMore ?? false,
    commits: entries
  };
}

export function snapshotAfter(
  batch: Extract<PublicProjectionReadBatch, { status: 'ok' }>,
  overrides: Partial<PublicProjectionSnapshot>
): PublicProjectionSnapshot {
  return projectionSnapshot({
    streamId: batch.streamId,
    cursor: batch.nextCursor,
    cursorDigest: batch.nextDigest,
    ...overrides
  });
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

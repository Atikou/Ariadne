import { createHash } from 'node:crypto';
import {
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  PUBLIC_PROJECTION_GENESIS_DIGEST,
  canonicalPublicProjectionJsonV3,
  type ProjectionCommitV3,
  type PublicMessageProjectionV3,
  type PublicModelProjectionV3,
  type PublicProjectionChangeV3,
  type PublicProjectionReadBatchV3,
  type PublicProjectionSnapshotV3,
  type PublicRunProjectionV3,
  type PublicSessionProjectionV3
} from '@ariadne/protocol/public';

export const NOW = '2026-07-31T00:00:00.000Z';

export function projectionSnapshot(
  overrides: Partial<PublicProjectionSnapshotV3> = {}
): PublicProjectionSnapshotV3 {
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
    tombstones: [],
    ...overrides
  };
}

export function session(
  sessionId: string,
  version = 1
): PublicSessionProjectionV3 {
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
): PublicMessageProjectionV3 {
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
  status: PublicRunProjectionV3['status'] = 'running',
  version = 1
): PublicRunProjectionV3 {
  return {
    runId,
    sessionId: 'session-a',
    version,
    title: `Run ${runId}`,
    status,
    label: `Run ${status}`,
    toolActivities: [],
    updatedAt: NOW,
    startedAt: NOW
  };
}

export function model(modelId: string, version = 1): PublicModelProjectionV3 {
  return {
    modelId,
    version,
    label: `Model ${modelId}`,
    location: 'local',
    availability: 'ready',
    supportsAgent: true,
    supportsVision: false,
    updatedAt: NOW
  };
}

export function upsertChange(
  feature: PublicProjectionChangeV3['feature'],
  dto: PublicProjectionChangeV3['dto'] & { version: number },
  aggregateId: string
): PublicProjectionChangeV3 {
  return {
    feature,
    operation: 'upsert',
    aggregateId,
    aggregateVersion: dto.version,
    projectedAt: NOW,
    dto
  } as PublicProjectionChangeV3;
}

export function projectionCommit(
  eventId: string,
  changes: readonly PublicProjectionChangeV3[],
  sourceCursor = 1
): ProjectionCommitV3 {
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
  commits: readonly ProjectionCommitV3[],
  options: { streamId?: string; hasMore?: boolean } = {}
): Extract<PublicProjectionReadBatchV3, { status: 'ok' }> {
  let previous = afterDigest;
  const entries = commits.map((commit, index) => {
    const cursor = afterCursor + index + 1;
    const payloadDigest = digest(canonicalPublicProjectionJsonV3(commit));
    const cursorDigest = digest(
      `ariadne-public-projection-v3\u0000${previous}`
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
  batch: Extract<PublicProjectionReadBatchV3, { status: 'ok' }>,
  overrides: Partial<PublicProjectionSnapshotV3>
): PublicProjectionSnapshotV3 {
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

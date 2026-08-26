import {
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  PUBLIC_PROJECTION_GENESIS_DIGEST,
  assertPublicProjectionReadBatchV3,
  assertPublicProjectionSnapshotV3,
  canonicalPublicProjectionJsonV3,
  type PublicDecisionProjectionV3,
  type PublicDiagnosticProjectionV3,
  type PublicMessageProjectionV3,
  type PublicModelProjectionV3,
  type PublicProjectionChangeV3,
  type PublicProjectionReadBatchV3,
  type PublicProjectionReadRequestV3,
  type PublicProjectionSnapshotV3,
  type PublicRunProjectionV3,
  type PublicSessionProjectionV3
} from '@ariadne/protocol/public';
import { DecisionStore, type DecisionProjectionChange } from './decision-store';
import { DiagnosticsStore, type DiagnosticsProjectionChange } from './diagnostics-store';
import { MessageStore, type MessageProjectionChange } from './message-store';
import { ModelStore, type ModelProjectionChange } from './model-store';
import { RunStore, type RunProjectionChange } from './run-store';
import { SessionStore, type SessionProjectionChange } from './session-store';

export type ProjectionResetReason =
  | 'stream_mismatch'
  | 'contract_mismatch'
  | 'cursor_gap'
  | 'history_mismatch';

export type ProjectionBatchApplication =
  | { readonly status: 'applied' | 'stale' }
  | { readonly status: 'reset_required'; readonly reason: ProjectionResetReason };

export interface ProjectionCacheSnapshot {
  readonly streamId: string | null;
  readonly cursor: number;
  readonly cursorDigest: string;
  readonly resetEpoch: number;
  readonly integrityError: string | null;
  readonly sessions: readonly PublicSessionProjectionV3[];
  readonly messages: readonly PublicMessageProjectionV3[];
  readonly runs: readonly PublicRunProjectionV3[];
  readonly decisions: readonly PublicDecisionProjectionV3[];
  readonly models: readonly PublicModelProjectionV3[];
  readonly diagnostics: readonly PublicDiagnosticProjectionV3[];
}

export class ProjectionIntegrityError extends Error {
  constructor(readonly integrityCode: string) {
    super(`projection_integrity_error:${integrityCode}`);
    this.name = 'ProjectionIntegrityError';
  }
}

export class ProjectionCache {
  readonly sessions = new SessionStore();
  readonly messages = new MessageStore();
  readonly runs = new RunStore();
  readonly decisions = new DecisionStore();
  readonly models = new ModelStore();
  readonly diagnostics = new DiagnosticsStore();

  private readonly listeners = new Set<() => void>();
  private streamId: string | null = null;
  private cursor = 0;
  private cursorDigest: string = PUBLIC_PROJECTION_GENESIS_DIGEST;
  private resetEpoch = 0;
  private integrityFailure: ProjectionIntegrityError | null = null;
  private eventFingerprints = new Map<string, string>();
  private digestByCursor = new Map<number, string>([
    [0, PUBLIC_PROJECTION_GENESIS_DIGEST]
  ]);
  private snapshot = this.createSnapshot();

  getSnapshot = (): ProjectionCacheSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  createReadRequest(limit = 500): PublicProjectionReadRequestV3 {
    this.assertHealthy();
    if (this.streamId === null) throw this.latch('snapshot_required');
    return {
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      streamId: this.streamId,
      afterCursor: this.cursor,
      afterDigest: this.cursorDigest,
      limit
    };
  }

  replaceSnapshot(input: PublicProjectionSnapshotV3): void {
    this.assertHealthy();
    try {
      const snapshot = assertPublicProjectionSnapshotV3(input);
      const preparedSessions = this.sessions.prepareSnapshot(
        snapshot.sessions,
        tombstonesFor(snapshot, 'sessions')
      );
      const preparedMessages = this.messages.prepareSnapshot(
        snapshot.messages,
        tombstonesFor(snapshot, 'messages')
      );
      const preparedRuns = this.runs.prepareSnapshot(
        snapshot.runs,
        tombstonesFor(snapshot, 'runs')
      );
      const preparedDecisions = this.decisions.prepareSnapshot(
        snapshot.decisions,
        tombstonesFor(snapshot, 'decisions')
      );
      const preparedModels = this.models.prepareSnapshot(
        snapshot.models,
        tombstonesFor(snapshot, 'models')
      );
      const preparedDiagnostics = this.diagnostics.prepareSnapshot(
        snapshot.diagnostics,
        tombstonesFor(snapshot, 'diagnostics')
      );

      this.sessions.commitPrepared(preparedSessions);
      this.messages.commitPrepared(preparedMessages);
      this.runs.commitPrepared(preparedRuns);
      this.decisions.commitPrepared(preparedDecisions);
      this.models.commitPrepared(preparedModels);
      this.diagnostics.commitPrepared(preparedDiagnostics);
      this.streamId = snapshot.streamId;
      this.cursor = snapshot.cursor;
      this.cursorDigest = snapshot.cursorDigest;
      this.eventFingerprints = new Map();
      this.digestByCursor = new Map([
        [snapshot.cursor, snapshot.cursorDigest],
        ...(snapshot.cursor === 0
          ? [] as Array<[number, string]>
          : [[0, PUBLIC_PROJECTION_GENESIS_DIGEST] as [number, string]])
      ]);
      this.resetEpoch += 1;
      this.publish();
    } catch (error) {
      throw this.latch(errorCode(error));
    }
  }

  async applyBatch(input: PublicProjectionReadBatchV3): Promise<ProjectionBatchApplication> {
    this.assertHealthy();
    if (input.status === 'reset_required') {
      return { status: 'reset_required', reason: input.reason };
    }
    if (input.contractVersion !== PUBLIC_PROJECTION_CONTRACT_VERSION) {
      return { status: 'reset_required', reason: 'contract_mismatch' };
    }
    if (this.streamId === null) {
      return { status: 'reset_required', reason: 'stream_mismatch' };
    }
    if (input.streamId !== this.streamId) {
      return { status: 'reset_required', reason: 'stream_mismatch' };
    }
    if (!hasContiguousCursors(input)) {
      return { status: 'reset_required', reason: 'cursor_gap' };
    }

    const historicalDigest = this.digestByCursor.get(input.afterCursor);
    if (input.afterCursor < this.cursor) {
      const nextHistoricalDigest = this.digestByCursor.get(input.nextCursor);
      if (
        historicalDigest !== input.afterDigest
        || input.nextCursor > this.cursor
        || nextHistoricalDigest !== input.nextDigest
      ) {
        return { status: 'reset_required', reason: 'history_mismatch' };
      }
      try {
        await verifyDigestChain(input);
        return { status: 'stale' };
      } catch (error) {
        throw this.latch(errorCode(error));
      }
    }
    if (input.afterCursor > this.cursor) {
      return { status: 'reset_required', reason: 'cursor_gap' };
    }
    if (input.afterDigest !== this.cursorDigest) {
      return { status: 'reset_required', reason: 'history_mismatch' };
    }

    try {
      const batch = assertPublicProjectionReadBatchV3(input);
      if (batch.status !== 'ok') return { status: 'reset_required', reason: batch.reason };
      await verifyDigestChain(batch);

      const nextEvents = new Map(this.eventFingerprints);
      const changes = collectNewChanges(batch, nextEvents);
      const preparedSessions = changes.sessions.length === 0
        ? null
        : this.sessions.prepareChanges(changes.sessions);
      const preparedMessages = changes.messages.length === 0
        ? null
        : this.messages.prepareChanges(changes.messages);
      const preparedRuns = changes.runs.length === 0
        ? null
        : this.runs.prepareChanges(changes.runs);
      const preparedDecisions = changes.decisions.length === 0
        ? null
        : this.decisions.prepareChanges(changes.decisions);
      const preparedModels = changes.models.length === 0
        ? null
        : this.models.prepareChanges(changes.models);
      const preparedDiagnostics = changes.diagnostics.length === 0
        ? null
        : this.diagnostics.prepareChanges(changes.diagnostics);

      if (preparedSessions) this.sessions.commitPrepared(preparedSessions);
      if (preparedMessages) this.messages.commitPrepared(preparedMessages);
      if (preparedRuns) this.runs.commitPrepared(preparedRuns);
      if (preparedDecisions) this.decisions.commitPrepared(preparedDecisions);
      if (preparedModels) this.models.commitPrepared(preparedModels);
      if (preparedDiagnostics) this.diagnostics.commitPrepared(preparedDiagnostics);
      this.eventFingerprints = nextEvents;
      for (const entry of batch.commits) {
        this.digestByCursor.set(entry.cursor, entry.cursorDigest);
      }
      trimCursorHistory(this.digestByCursor);
      this.cursor = batch.nextCursor;
      this.cursorDigest = batch.nextDigest;
      this.publish();
      return { status: 'applied' };
    } catch (error) {
      throw this.latch(errorCode(error));
    }
  }

  clearForRuntimeReset(): void {
    this.sessions.clear();
    this.messages.clear();
    this.runs.clear();
    this.decisions.clear();
    this.models.clear();
    this.diagnostics.clear();
    this.streamId = null;
    this.cursor = 0;
    this.cursorDigest = PUBLIC_PROJECTION_GENESIS_DIGEST;
    this.eventFingerprints.clear();
    this.digestByCursor = new Map([[0, PUBLIC_PROJECTION_GENESIS_DIGEST]]);
    this.resetEpoch += 1;
    this.publish();
  }

  resetLifecycle(): void {
    this.integrityFailure = null;
    this.clearForRuntimeReset();
  }

  lockIntegrity(code: string): void {
    this.latch(code);
  }

  private assertHealthy(): void {
    if (this.integrityFailure !== null) throw this.integrityFailure;
  }

  private latch(code: string): ProjectionIntegrityError {
    if (this.integrityFailure === null) {
      this.integrityFailure = new ProjectionIntegrityError(code);
      this.publish();
    }
    return this.integrityFailure;
  }

  private publish(): void {
    this.snapshot = this.createSnapshot();
    for (const listener of this.listeners) listener();
  }

  private createSnapshot(): ProjectionCacheSnapshot {
    return Object.freeze({
      streamId: this.streamId,
      cursor: this.cursor,
      cursorDigest: this.cursorDigest,
      resetEpoch: this.resetEpoch,
      integrityError: this.integrityFailure?.message ?? null,
      sessions: this.sessions.getSnapshot(),
      messages: this.messages.getSnapshot(),
      runs: this.runs.getSnapshot(),
      decisions: this.decisions.getSnapshot(),
      models: this.models.getSnapshot(),
      diagnostics: this.diagnostics.getSnapshot()
    });
  }
}

function tombstonesFor(
  snapshot: PublicProjectionSnapshotV3,
  feature: PublicProjectionChangeV3['feature']
): PublicProjectionSnapshotV3['tombstones'] {
  return snapshot.tombstones.filter((entry) => entry.feature === feature);
}

interface CollectedChanges {
  readonly sessions: SessionProjectionChange[];
  readonly messages: MessageProjectionChange[];
  readonly runs: RunProjectionChange[];
  readonly decisions: DecisionProjectionChange[];
  readonly models: ModelProjectionChange[];
  readonly diagnostics: DiagnosticsProjectionChange[];
}

function collectNewChanges(
  batch: Extract<PublicProjectionReadBatchV3, { status: 'ok' }>,
  events: Map<string, string>
): CollectedChanges {
  const collected: CollectedChanges = {
    sessions: [],
    messages: [],
    runs: [],
    decisions: [],
    models: [],
    diagnostics: []
  };
  for (const entry of batch.commits) {
    const fingerprint = canonicalPublicProjectionJsonV3(entry.commit);
    const existing = events.get(entry.commit.eventId);
    if (existing !== undefined) {
      if (existing !== fingerprint) {
        throw new Error(`projection_event_payload_drift:${entry.commit.eventId}`);
      }
      continue;
    }
    events.set(entry.commit.eventId, fingerprint);
    for (const change of entry.commit.changes) collectChange(collected, change);
  }
  return collected;
}

function collectChange(collected: CollectedChanges, change: PublicProjectionChangeV3): void {
  switch (change.feature) {
    case 'sessions': collected.sessions.push(change); return;
    case 'messages': collected.messages.push(change); return;
    case 'runs': collected.runs.push(change); return;
    case 'decisions': collected.decisions.push(change); return;
    case 'models': collected.models.push(change); return;
    case 'diagnostics': collected.diagnostics.push(change);
  }
}

function hasContiguousCursors(
  batch: Extract<PublicProjectionReadBatchV3, { status: 'ok' }>
): boolean {
  let expected = batch.afterCursor + 1;
  for (const entry of batch.commits) {
    if (entry.cursor !== expected) return false;
    expected += 1;
  }
  const last = batch.commits.at(-1);
  return batch.nextCursor === (last?.cursor ?? batch.afterCursor)
    && batch.nextDigest === (last?.cursorDigest ?? batch.afterDigest);
}

async function verifyDigestChain(
  batch: Extract<PublicProjectionReadBatchV3, { status: 'ok' }>
): Promise<void> {
  let previousDigest = batch.afterDigest;
  for (const entry of batch.commits) {
    const payloadDigest = await sha256(canonicalPublicProjectionJsonV3(entry.commit));
    const expected = await sha256(
      `ariadne-public-projection-v3\u0000${previousDigest}`
      + `\u0000${String(entry.cursor)}\u0000${payloadDigest}`
    );
    if (entry.cursorDigest !== expected) {
      throw new Error(`projection_history_digest_drift:${String(entry.cursor)}`);
    }
    previousDigest = entry.cursorDigest;
  }
  if (batch.nextDigest !== previousDigest) {
    throw new Error('projection_next_digest_drift');
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}`;
}

function trimCursorHistory(history: Map<number, string>): void {
  while (history.size > 4_001) {
    const oldest = history.keys().next();
    if (oldest.done) return;
    history.delete(oldest.value);
  }
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[^A-Za-z0-9_.:-]+/gu, '_').slice(0, 512) || 'unknown';
}

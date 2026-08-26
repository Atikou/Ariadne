import { createHash } from 'node:crypto';

import {
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  publicModelProjectionV3Schema,
  publicProjectionCanonicalIdSchema,
  type ProjectionCommitV3,
  type PublicModelProjectionV3,
  type PublicProjectionChangeV3
} from '@ariadne/protocol/public';

import type {
  ModelCatalogProjectionEntry,
  ModelCatalogProjectionHead,
  ModelCatalogProjectionSource,
  ModelCatalogPublicProjectionStore
} from './ModelCatalogProjectionPorts.js';
import { assertValidProjectionCommitV3 } from './PublicProjectionContractV3.js';

const DEFAULT_SOURCE_ID = 'model-catalog';
const DEFAULT_MAX_CHANGES_PER_COMMIT = 256;
const ENTRY_VALIDATION_TIME = '2000-01-01T00:00:00.000Z';

export interface ModelCatalogPublicProjectionPublisherOptions {
  readonly sourceId?: string;
  readonly maxChangesPerCommit?: number;
  readonly now?: () => Date;
}

export interface ModelCatalogPublicProjectionPublishResult {
  readonly observedModels: number;
  readonly publishedChanges: number;
  readonly sourceCursor: number;
}

export type ModelCatalogProjectionPublished = (
  commit: ProjectionCommitV3
) => void | Promise<void>;

interface PendingCommit {
  readonly commit: ProjectionCommitV3;
  readonly observedModels: number;
  readonly publishedChanges: number;
  readonly sourceCursor: number;
}

interface PlannedChange {
  readonly entry: ModelCatalogProjectionEntry | null;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
}

/**
 * Reconciles the Runtime-owned current model catalog into the one durable
 * public Projection stream. A commit remains pinned until append is
 * acknowledged, so a lost post-COMMIT acknowledgement always retries the exact
 * same event and payload.
 */
export class ModelCatalogPublicProjectionPublisher {
  private readonly sourceId: string;
  private readonly maxChangesPerCommit: number;
  private readonly now: () => Date;
  private activePublish: Promise<ModelCatalogPublicProjectionPublishResult> | null = null;
  private pendingCommit: PendingCommit | null = null;

  public constructor(
    private readonly source: ModelCatalogProjectionSource,
    private readonly projection: ModelCatalogPublicProjectionStore,
    options: ModelCatalogPublicProjectionPublisherOptions = {},
    private readonly onPublished?: ModelCatalogProjectionPublished
  ) {
    this.sourceId = publicProjectionCanonicalIdSchema.parse(
      options.sourceId ?? DEFAULT_SOURCE_ID
    );
    this.maxChangesPerCommit = options.maxChangesPerCommit
      ?? DEFAULT_MAX_CHANGES_PER_COMMIT;
    if (
      !Number.isSafeInteger(this.maxChangesPerCommit)
      || this.maxChangesPerCommit < 1
      || this.maxChangesPerCommit > DEFAULT_MAX_CHANGES_PER_COMMIT
    ) {
      throw new Error('model_catalog_projection_batch_limit_invalid');
    }
    this.now = options.now ?? (() => new Date());
  }

  /** Concurrent calls share one reconciliation/append operation. */
  public publishPending(): Promise<ModelCatalogPublicProjectionPublishResult> {
    if (this.activePublish === null) {
      this.activePublish = this.publishOnce().finally(() => {
        this.activePublish = null;
      });
    }
    return this.activePublish;
  }

  private async publishOnce(): Promise<ModelCatalogPublicProjectionPublishResult> {
    if (this.pendingCommit !== null) return this.appendPending(this.pendingCommit);

    const [sourceEntries, heads, sourceCursor] = await Promise.all([
      this.source.snapshot(),
      this.projection.readModelProjectionHeads(),
      this.projection.readPublicProjectionSourceCheckpoint(this.sourceId)
    ]);
    const entries = normalizeEntries(sourceEntries);
    const normalizedHeads = normalizeHeads(heads);
    const planned = planChanges(entries, normalizedHeads)
      .slice(0, this.maxChangesPerCommit);
    if (planned.length === 0) {
      return {
        observedModels: entries.size,
        publishedChanges: 0,
        sourceCursor
      };
    }

    const occurredAt = canonicalNow(this.now);
    const nextSourceCursor = sourceCursor + 1;
    if (!Number.isSafeInteger(nextSourceCursor)) {
      throw new Error('model_catalog_projection_source_cursor_exhausted');
    }
    const changes = planned.map((change) => projectChange(change, occurredAt));
    const commit = assertValidProjectionCommitV3({
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      eventId: modelCatalogProjectionEventId(this.sourceId, nextSourceCursor),
      sourceId: this.sourceId,
      sourceCursor: nextSourceCursor,
      occurredAt,
      changes
    });
    const pending = {
      commit,
      observedModels: entries.size,
      publishedChanges: changes.length,
      sourceCursor: nextSourceCursor
    } satisfies PendingCommit;
    this.pendingCommit = pending;
    return this.appendPending(pending);
  }

  private async appendPending(
    pending: PendingCommit
  ): Promise<ModelCatalogPublicProjectionPublishResult> {
    await this.projection.append(pending.commit);
    await this.onPublished?.(pending.commit);
    if (this.pendingCommit === pending) this.pendingCommit = null;
    return {
      observedModels: pending.observedModels,
      publishedChanges: pending.publishedChanges,
      sourceCursor: pending.sourceCursor
    };
  }
}

export function modelCatalogProjectionEventId(
  sourceId: string,
  sourceCursor: number
): string {
  publicProjectionCanonicalIdSchema.parse(sourceId);
  if (!Number.isSafeInteger(sourceCursor) || sourceCursor < 1) {
    throw new Error('model_catalog_projection_identity_invalid');
  }
  const digest = createHash('sha256')
    .update(JSON.stringify([
      'ariadne.model-catalog.changed',
      sourceId,
      sourceCursor
    ]), 'utf8')
    .digest('hex');
  return `model-catalog.changed:${digest}`;
}

function normalizeEntries(
  values: readonly ModelCatalogProjectionEntry[]
): ReadonlyMap<string, ModelCatalogProjectionEntry> {
  if (!Array.isArray(values)) {
    throw new Error('model_catalog_projection_snapshot_invalid');
  }
  const entries = new Map<string, ModelCatalogProjectionEntry>();
  for (const value of values) {
    const dto = publicModelProjectionV3Schema.parse({
      modelId: value?.id,
      version: 1,
      label: value?.label,
      location: value?.location,
      availability: value?.availability,
      supportsAgent: value?.supportsAgent,
      supportsVision: value?.supportsVision,
      updatedAt: ENTRY_VALIDATION_TIME
    });
    if (entries.has(dto.modelId)) {
      throw new Error(`model_catalog_projection_duplicate:${dto.modelId}`);
    }
    entries.set(dto.modelId, Object.freeze({
      id: dto.modelId,
      label: dto.label,
      location: dto.location,
      availability: dto.availability,
      supportsAgent: dto.supportsAgent,
      supportsVision: dto.supportsVision
    }));
  }
  return entries;
}

function normalizeHeads(
  values: readonly ModelCatalogProjectionHead[]
): ReadonlyMap<string, ModelCatalogProjectionHead> {
  const heads = new Map<string, ModelCatalogProjectionHead>();
  for (const value of values) {
    const aggregateId = publicProjectionCanonicalIdSchema.parse(value.aggregateId);
    if (
      !Number.isSafeInteger(value.aggregateVersion)
      || value.aggregateVersion < 1
      || (value.operation !== 'upsert' && value.operation !== 'delete')
      || (value.operation === 'delete') !== (value.dto === null)
    ) {
      throw new Error(`model_catalog_projection_head_invalid:${aggregateId}`);
    }
    const dto = value.dto === null ? null : publicModelProjectionV3Schema.parse(value.dto);
    if (
      dto !== null
      && (dto.modelId !== aggregateId || dto.version !== value.aggregateVersion)
    ) {
      throw new Error(`model_catalog_projection_head_identity_drift:${aggregateId}`);
    }
    if (heads.has(aggregateId)) {
      throw new Error(`model_catalog_projection_head_duplicate:${aggregateId}`);
    }
    heads.set(aggregateId, {
      aggregateId,
      aggregateVersion: value.aggregateVersion,
      operation: value.operation,
      dto
    });
  }
  return heads;
}

function planChanges(
  entries: ReadonlyMap<string, ModelCatalogProjectionEntry>,
  heads: ReadonlyMap<string, ModelCatalogProjectionHead>
): PlannedChange[] {
  const ids = [...new Set([...entries.keys(), ...heads.keys()])].sort(compareCodeUnits);
  const changes: PlannedChange[] = [];
  for (const aggregateId of ids) {
    const entry = entries.get(aggregateId);
    const head = heads.get(aggregateId);
    if (entry === undefined) {
      if (head?.operation === 'upsert') {
        changes.push({
          entry: null,
          aggregateId,
          aggregateVersion: head.aggregateVersion + 1
        });
      }
      continue;
    }
    if (
      head?.operation === 'upsert'
      && head.dto !== null
      && samePublicState(entry, head.dto)
    ) {
      continue;
    }
    changes.push({
      entry,
      aggregateId,
      aggregateVersion: (head?.aggregateVersion ?? 0) + 1
    });
  }
  return changes;
}

function projectChange(
  change: PlannedChange,
  projectedAt: string
): PublicProjectionChangeV3 {
  if (!Number.isSafeInteger(change.aggregateVersion)) {
    throw new Error(`model_catalog_projection_version_exhausted:${change.aggregateId}`);
  }
  if (change.entry === null) {
    return {
      feature: 'models',
      operation: 'delete',
      aggregateId: change.aggregateId,
      aggregateVersion: change.aggregateVersion,
      projectedAt,
      dto: null
    };
  }
  const dto: PublicModelProjectionV3 = publicModelProjectionV3Schema.parse({
    modelId: change.entry.id,
    version: change.aggregateVersion,
    label: change.entry.label,
    location: change.entry.location,
    availability: change.entry.availability,
    supportsAgent: change.entry.supportsAgent,
    supportsVision: change.entry.supportsVision,
    updatedAt: projectedAt
  });
  return {
    feature: 'models',
    operation: 'upsert',
    aggregateId: change.aggregateId,
    aggregateVersion: change.aggregateVersion,
    projectedAt,
    dto
  };
}

function samePublicState(
  entry: ModelCatalogProjectionEntry,
  current: PublicModelProjectionV3
): boolean {
  return entry.id === current.modelId
    && entry.label === current.label
    && entry.location === current.location
    && entry.availability === current.availability
    && entry.supportsAgent === current.supportsAgent
    && entry.supportsVision === current.supportsVision;
}

function canonicalNow(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('model_catalog_projection_clock_invalid');
  }
  return value.toISOString();
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

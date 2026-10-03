import { canonicalPublicProjectionJsonV3 } from '@ariadne/protocol/public';

export interface ProjectionEntity {
  readonly version: number;
}

export interface ProjectionFeatureChange<T extends ProjectionEntity> {
  readonly operation: 'upsert' | 'delete';
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly dto: T | null;
}

export interface ProjectionSnapshotTombstone {
  readonly aggregateId: string;
  readonly aggregateVersion: number;
}

interface ProjectionHead<T extends ProjectionEntity> {
  readonly version: number;
  readonly value: T | null;
  readonly fingerprint: string;
}

export interface PreparedProjectionFeature<T extends ProjectionEntity> {
  readonly heads: ReadonlyMap<string, ProjectionHead<T>>;
  readonly visible: readonly T[];
}

/**
 * Owns one projection feature only. Mutation is two phase so a multi-feature
 * commit can validate every slice before any observable state changes.
 */
export class ProjectionFeatureStore<T extends ProjectionEntity> {
  private heads: ReadonlyMap<string, ProjectionHead<T>> = new Map();
  private visible: readonly T[] = Object.freeze([]);

  constructor(private readonly identify: (entity: T) => string) {}

  getSnapshot(): readonly T[] {
    return this.visible;
  }

  prepareSnapshot(
    values: readonly T[],
    tombstones: readonly ProjectionSnapshotTombstone[] = []
  ): PreparedProjectionFeature<T> {
    const heads = new Map<string, ProjectionHead<T>>();
    for (const source of values) {
      const value = immutableClone(source);
      const id = this.identify(value);
      if (heads.has(id)) throw new Error(`projection_snapshot_duplicate:${id}`);
      heads.set(id, {
        version: value.version,
        value,
        fingerprint: canonicalPublicProjectionJsonV3(value)
      });
    }
    for (const tombstone of tombstones) {
      if (heads.has(tombstone.aggregateId)) {
        throw new Error(`projection_snapshot_duplicate:${tombstone.aggregateId}`);
      }
      if (
        !Number.isSafeInteger(tombstone.aggregateVersion)
        || tombstone.aggregateVersion < 1
      ) {
        throw new Error(
          `projection_snapshot_version_invalid:${tombstone.aggregateId}:`
          + String(tombstone.aggregateVersion)
        );
      }
      heads.set(tombstone.aggregateId, {
        version: tombstone.aggregateVersion,
        value: null,
        fingerprint: 'delete'
      });
    }
    return prepared(heads, this.identify);
  }

  prepareChanges(
    changes: readonly ProjectionFeatureChange<T>[]
  ): PreparedProjectionFeature<T> {
    let heads: Map<string, ProjectionHead<T>> | undefined;
    for (const change of changes) {
      const current = (heads ?? this.heads).get(change.aggregateId);
      const currentVersion = current?.version ?? 0;
      const nextFingerprint = change.dto === null
        ? 'delete'
        : canonicalPublicProjectionJsonV3(change.dto);

      if (change.aggregateVersion === currentVersion) {
        if (
          current !== undefined
          && current.fingerprint === nextFingerprint
          && ((current.value === null) === (change.dto === null))
        ) {
          continue;
        }
        throw new Error(
          `projection_aggregate_drift:${change.aggregateId}:${String(change.aggregateVersion)}`
        );
      }
      if (change.aggregateVersion !== currentVersion + 1) {
        throw new Error(
          `projection_aggregate_version_invariant:${change.aggregateId}:`
          + `${String(currentVersion + 1)}:${String(change.aggregateVersion)}`
        );
      }

      const value = change.dto === null ? null : immutableClone(change.dto);
      if (value !== null && this.identify(value) !== change.aggregateId) {
        throw new Error(`projection_aggregate_identity_drift:${change.aggregateId}`);
      }
      heads ??= new Map(this.heads);
      heads.set(change.aggregateId, {
        version: change.aggregateVersion,
        value,
        fingerprint: nextFingerprint
      });
    }
    return heads === undefined
      ? { heads: this.heads, visible: this.visible }
      : prepared(heads, this.identify);
  }

  commitPrepared(preparedState: PreparedProjectionFeature<T>): void {
    this.heads = preparedState.heads;
    this.visible = preparedState.visible;
  }

  clear(): void {
    this.heads = new Map();
    this.visible = Object.freeze([]);
  }
}

function prepared<T extends ProjectionEntity>(
  heads: ReadonlyMap<string, ProjectionHead<T>>,
  identify: (entity: T) => string
): PreparedProjectionFeature<T> {
  const visible = [...heads.values()]
    .flatMap((head) => head.value === null ? [] : [head.value])
    .sort((left, right) => compareCodeUnits(identify(left), identify(right)));
  return {
    heads,
    visible: Object.freeze(visible)
  };
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function immutableClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { acquireSqliteOwnerLease, closeOwnedSqliteDatabase, type SqliteOwnerLease } from '../../adapters/persistence/SqliteOwnerLease.js';
import { initializeModelCapabilitySchema } from './ModelCapabilityDbSchema.js';
import type { ModelCapabilityAuthority } from './ModelCapabilityAuthority.js';
import { DATABASE_PATHS } from '../../adapters/persistence/DatabasePaths.js';
import { SqliteAuthorityHealth, attributeSqliteOpeningFault } from '../../adapters/persistence/SqliteAuthorityHealth.js';
import { auditModelCapabilityAuthority, readStoredQualification, type StoredQualificationRow } from './ModelCapabilityRecords.js';

import {
  assertQualificationReport,
  unknownQualification,
  type ModelCapabilityQualification
} from './ModelCapabilityQualification.js';

/** Runtime-owned authority for capability evidence bound to an exact model fingerprint. */
export class ModelCapabilityRegistry implements ModelCapabilityAuthority {
  private readonly database: DatabaseSync;
  private readonly ownerLease: SqliteOwnerLease;
  private readonly currentFingerprints = new Map<string, string>();
  private closed = false;
  private readonly health = new SqliteAuthorityHealth('inference');

  public constructor(databasePath: string) {
    const resolved = path.resolve(databasePath);
    mkdirSync(path.dirname(resolved), { recursive: true });
    const lease = acquireSqliteOwnerLease(resolved, 'model-capability');
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(resolved);
      initializeModelCapabilitySchema(database, auditModelCapabilityAuthority);
      database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      this.database = database; this.ownerLease = lease;
    } catch (error) {
      attributeSqliteOpeningFault('inference', error);
      if (!database) lease.close(); else try { closeOwnedSqliteDatabase(database,lease); }
      catch (closeError) { throw new AggregateError([error, closeError], 'model_capability_open_cleanup_failed'); }
      throw error;
    }
  }

  public registerFingerprint(providerId: string, modelId: string, fingerprint: string): void {
    this.assertOpen();
    assertIdentity(providerId, modelId, fingerprint);
    this.currentFingerprints.set(modelKey(providerId, modelId), fingerprint);
  }

  public current(providerId: string, modelId: string): ModelCapabilityQualification | null {
    this.assertOpen();
    const fingerprint = this.currentFingerprints.get(modelKey(providerId, modelId));
    return fingerprint === undefined ? null : this.read(providerId, modelId, fingerprint);
  }

  public currentFingerprint(providerId: string, modelId: string): string | null {
    this.assertOpen();
    return this.currentFingerprints.get(modelKey(providerId, modelId)) ?? null;
  }

  public read(
    providerId: string,
    modelId: string,
    fingerprint: string
  ): ModelCapabilityQualification {
    this.assertOpen();
    assertIdentity(providerId, modelId, fingerprint);
    return this.observe(() => {
    const row = this.database.prepare(`
      SELECT *
      FROM model_capability_qualification
      WHERE provider_id = ? AND model_id = ? AND fingerprint = ?
    `).get(providerId, modelId, fingerprint) as unknown as StoredQualificationRow | undefined;
    if (row === undefined) return unknownQualification({ providerId, modelId, fingerprint });
    return readStoredQualification(row);
    });
  }

  public write(report: ModelCapabilityQualification): void {
    this.assertOpen();
    const proposed = assertQualificationReport(report);
    const existingQuality = this.read(proposed.providerId, proposed.modelId, proposed.fingerprint).quality;
    // Preserve existing historical evidence when refreshing capabilities.
    // There is no producer of new quality scores and they never affect routing.
    const valid = existingQuality === undefined ? proposed : { ...proposed, quality: existingQuality };
    this.observe(() => this.database.prepare(`
      INSERT INTO model_capability_qualification (
        provider_id, model_id, fingerprint, adapter_protocol_version, report_json, tested_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_id, model_id, fingerprint) DO UPDATE SET
        adapter_protocol_version = excluded.adapter_protocol_version,
        report_json = excluded.report_json,
        tested_at = excluded.tested_at
    `).run(
      valid.providerId,
      valid.modelId,
      valid.fingerprint,
      valid.adapterProtocolVersion,
      JSON.stringify(valid),
      valid.testedAt ?? null
    ));
  }

  public close(): void {
    if (this.closed) return;
    closeOwnedSqliteDatabase(this.database,this.ownerLease);
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('model_capability_registry_closed');
    this.health.assertHealthy();
  }
  public assertHealthy(): void { this.assertOpen(); }
  private observe<T>(operation: () => T): T {
    this.health.assertHealthy();
    try { return operation(); } catch (error) { this.health.observe(error); throw error; }
  }
}

function modelKey(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`;
}

function assertIdentity(providerId: string, modelId: string, fingerprint: string): void {
  if (!providerId.trim() || !modelId.trim() || !/^sha256:[a-f0-9]{64}$/u.test(fingerprint)) {
    throw new Error('model_capability_identity_invalid');
  }
}

export function qualificationDatabasePath(dataRoot: string): string {
  const target = path.resolve(dataRoot, DATABASE_PATHS.modelCapability);
  const root = path.dirname(target);
  if (existsSync(path.join(root, 'model-capability-v1.db'))) throw new Error('model_capability_database_name_migration_required');
  return target;
}

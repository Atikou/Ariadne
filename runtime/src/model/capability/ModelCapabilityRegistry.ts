import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  MODEL_CAPABILITY_ADAPTER_PROTOCOL_VERSION,
  assertQualificationReport,
  unknownQualification,
  type ModelCapabilityQualification
} from './ModelCapabilityQualification.js';

const STORAGE_SCHEMA_VERSION = 1;

interface StoredQualificationRow {
  readonly report_json: string;
}

/** Runtime-owned authority for capability evidence bound to an exact model fingerprint. */
export class ModelCapabilityRegistry {
  private readonly database: DatabaseSync;
  private readonly currentFingerprints = new Map<string, string>();
  private closed = false;

  public constructor(databasePath: string) {
    const resolved = path.resolve(databasePath);
    mkdirSync(path.dirname(resolved), { recursive: true });
    this.database = new DatabaseSync(resolved);
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    this.initializeSchema();
  }

  public registerFingerprint(providerId: string, modelId: string, fingerprint: string): void {
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
    const row = this.database.prepare(`
      SELECT report_json
      FROM model_capability_qualification
      WHERE provider_id = ? AND model_id = ? AND fingerprint = ?
    `).get(providerId, modelId, fingerprint) as unknown as StoredQualificationRow | undefined;
    if (row === undefined) return unknownQualification({ providerId, modelId, fingerprint });
    const parsed = JSON.parse(row.report_json) as ModelCapabilityQualification;
    return Object.freeze({ ...assertQualificationReport(parsed) });
  }

  public write(report: ModelCapabilityQualification): void {
    this.assertOpen();
    const valid = assertQualificationReport(report);
    this.database.prepare(`
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
    );
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private initializeSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS model_capability_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL
      );
    `);
    const metadata = this.database.prepare(`
      SELECT schema_version FROM model_capability_metadata WHERE singleton = 1
    `).get() as unknown as { readonly schema_version: number } | undefined;
    if (metadata !== undefined && metadata.schema_version !== STORAGE_SCHEMA_VERSION) {
      this.database.exec(`
        DROP TABLE IF EXISTS model_capability_qualification;
        DELETE FROM model_capability_metadata;
      `);
    }
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS model_capability_qualification (
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        adapter_protocol_version INTEGER NOT NULL,
        report_json TEXT NOT NULL,
        tested_at TEXT,
        PRIMARY KEY (provider_id, model_id, fingerprint)
      );
      INSERT INTO model_capability_metadata (singleton, schema_version)
      VALUES (1, ${String(STORAGE_SCHEMA_VERSION)})
      ON CONFLICT(singleton) DO UPDATE SET schema_version = excluded.schema_version;
    `);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('model_capability_registry_closed');
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
  return path.join(
    path.resolve(dataRoot),
    'data',
    'model-capability',
    `model-capability-v${String(MODEL_CAPABILITY_ADAPTER_PROTOCOL_VERSION)}.db`
  );
}

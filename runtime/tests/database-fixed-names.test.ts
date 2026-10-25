import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentControlDatabaseSchema, openAgentControlDatabase, resolveAgentControlDatabasePath } from '../src/adapters/persistence/agentControlDbSchema.js';
import { migrateAgentControlDatabaseNames } from '../src/adapters/persistence/AgentControlDatabaseNaming.js';
import { closeOwnedSqliteDatabase } from '../src/adapters/persistence/SqliteOwnerLease.js';
import { ModelCapabilityRegistry, qualificationDatabasePath } from '../src/model/capability/ModelCapabilityRegistry.js';
import { migrateModelCapabilityDatabaseName } from '../src/model/capability/ModelCapabilityDatabaseNaming.js';
import { unknownQualification } from '../src/model/capability/ModelCapabilityQualification.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const value = mkdtempSync(path.join(os.tmpdir(), 'ariadne-fixed-database-')); roots.push(value); return value; }
function oldAgent(directory: string) {
  const file = resolveAgentControlDatabasePath(directory); mkdirSync(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  try {
    createAgentControlDatabaseSchema(database, 7);
    const aggregate = JSON.stringify({ turns: [], binding: { toolCatalog: { catalogId: 'fixture', revision: 1, digest: `sha256:${'a'.repeat(64)}` } } });
    database.prepare('INSERT INTO agent_v3_runs VALUES(?,?,?,?,?,?)').run('run', 1, 'completed', aggregate, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');
    database.prepare('INSERT INTO agent_v3_commands VALUES(?,?,?,?,?)').run('command', `sha256:${'b'.repeat(64)}`, 1, 0, '2026-09-01T00:00:00Z');
    database.prepare('INSERT INTO agent_control_metadata VALUES(?,?,?)').run('keyring_generation', 'retained-generation', '2026-09-01T00:00:00Z');
    return { file, aggregate };
  } finally { database.close(); }
}

describe('fixed database names and preservation', () => {
  it('normalizes a non-empty Agent ledger, retains exact aggregates, receipts, metadata and a readable old backup', () => {
    const directory = root(); const source = oldAgent(directory);
    const result = migrateAgentControlDatabaseNames(directory);
    expect(result).toMatchObject({ migrated: true, fromVersion: 7, toVersion: 8 });
    const opened = openAgentControlDatabase(directory);
    try {
      expect(opened.database.prepare('SELECT aggregate_json FROM agent_runs').get()).toEqual({ aggregate_json: source.aggregate });
      expect(opened.database.prepare('SELECT command_id FROM agent_commands').get()).toEqual({ command_id: 'command' });
      expect(opened.database.prepare('SELECT value FROM agent_control_metadata').get()).toEqual({ value: 'retained-generation' });
      expect(opened.database.prepare("SELECT name FROM sqlite_master WHERE name GLOB '*_v[0-9]*'").all()).toEqual([]);
    } finally { closeOwnedSqliteDatabase(opened.database, opened.ownerLease); }
    const backup = new DatabaseSync(result.backupPath!, { readOnly: true });
    try { expect(backup.prepare('PRAGMA user_version').get()!.user_version).toBe(7);
      expect(backup.prepare('SELECT aggregate_json FROM agent_v3_runs').get()).toEqual({ aggregate_json: source.aggregate }); }
    finally { backup.close(); }
    expect(migrateAgentControlDatabaseNames(directory)).toMatchObject({ migrated: false });
  });

  it('rolls back a partially completed table rename and allows a safe retry', () => {
    const directory = root(); const source = oldAgent(directory); const bytes = readFileSync(source.file);
    const original = DatabaseSync.prototype.exec;
    const fault = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql.startsWith('ALTER TABLE "agent_v3_runs"')) throw new Error('injected_rename_failure');
      return original.call(this, sql);
    });
    try { expect(() => migrateAgentControlDatabaseNames(directory)).toThrow('injected_rename_failure'); }
    finally { fault.mockRestore(); }
    expect(readFileSync(source.file)).toEqual(bytes);
    expect(migrateAgentControlDatabaseNames(directory)).toMatchObject({ migrated: true });
  });

  it('rejects active and newer Agent owners before changing data', () => {
    const directory = root(); const source = oldAgent(directory);
    migrateAgentControlDatabaseNames(directory);
    const opened = openAgentControlDatabase(directory);
    try { expect(() => migrateAgentControlDatabaseNames(directory)).toThrow('sqlite_owner_lease_unavailable'); }
    finally { closeOwnedSqliteDatabase(opened.database, opened.ownerLease); }
    const future = new DatabaseSync(source.file); try { future.exec('PRAGMA user_version=9;'); } finally { future.close(); }
    const bytes = readFileSync(source.file);
    expect(() => migrateAgentControlDatabaseNames(directory)).toThrow('agent_control_naming_source_unsupported:9');
    expect(readFileSync(source.file)).toEqual(bytes);
  });

  it('adopts a fixed model database filename, preserves bytes and never silently creates an empty replacement', () => {
    const directory = root(); const oldPath = path.join(directory, 'data/model-capability/model-capability-v1.db');
    const registry = new ModelCapabilityRegistry(oldPath);
    registry.write(unknownQualification({ providerId: 'fixture', modelId: 'fixture', fingerprint: `sha256:${'c'.repeat(64)}` }));
    expect(() => migrateModelCapabilityDatabaseName(directory)).toThrow('sqlite_owner_lease_unavailable');
    registry.close(); const bytes = readFileSync(oldPath);
    expect(() => qualificationDatabasePath(directory)).toThrow('model_capability_database_name_migration_required');
    const result = migrateModelCapabilityDatabaseName(directory);
    expect(result.migrated).toBe(true); expect(existsSync(oldPath)).toBe(false);
    expect(readFileSync(result.databasePath)).toEqual(bytes); expect(readFileSync(result.backupPath!)).toEqual(bytes);
    expect(qualificationDatabasePath(directory)).toBe(path.join(directory, 'data/model-capability/model-capability.db'));
    expect(migrateModelCapabilityDatabaseName(directory)).toMatchObject({ migrated: false });
    const current = new ModelCapabilityRegistry(result.databasePath);
    try { expect(current.read('fixture', 'fixture', `sha256:${'c'.repeat(64)}`)).toMatchObject({ providerId: 'fixture' }); }
    finally { current.close(); }
  });

  it('refuses ambiguous model databases and retains both files', () => {
    const directory = root(); const parent = path.join(directory, 'data/model-capability');
    for (const name of ['model-capability-v1.db', 'model-capability.db']) new ModelCapabilityRegistry(path.join(parent, name)).close();
    const oldBytes = readFileSync(path.join(parent, 'model-capability-v1.db')); const currentBytes = readFileSync(path.join(parent, 'model-capability.db'));
    expect(() => migrateModelCapabilityDatabaseName(directory)).toThrow('model_capability_naming_dest_exists');
    expect(readFileSync(path.join(parent, 'model-capability-v1.db'))).toEqual(oldBytes);
    expect(readFileSync(path.join(parent, 'model-capability.db'))).toEqual(currentBytes);
  });
});

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { PUBLIC_PROJECTION_CONTRACT_VERSION } from '@ariadne/protocol/public';
import { SqliteProductivityStore } from '../src/adapters/persistence/SqliteProductivityStore.js';
import { auditProductivityAuthorityV2, auditProductivityAuthorityRecords } from '../src/adapters/persistence/ProductivityAuthorityAudit.js';
import { addProductivityTaskIsolationSchemaV3, PRODUCTIVITY_TASK_ISOLATION_SCHEMA_V3_DIGEST } from '../src/adapters/persistence/ProductivityTaskIsolationSchemaV3.js';
import { DATABASE_PATHS } from '../src/adapters/persistence/DatabasePaths.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';
import { migrateProductivityTaskIsolationV2ToV3 } from '../src/adapters/persistence/ProductivityTaskIsolationV2ToV3Migration.js';
import { SqliteProductivityTaskIsolation } from '../src/adapters/persistence/SqliteProductivityTaskIsolation.js';

const roots: string[] = [], databases: DatabaseSync[] = [];
const scope = { contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, workspaceId: 'audit-workspace', sessionId: 'audit-session' } as const;
const now = new Date('2098-01-01T00:00:00.000Z');
async function fixture(agent = false) {
  const directory = mkdtempSync(path.join(tmpdir(), 'AriadneTaskIsolationAudit-')); roots.push(directory);
  const store = new SqliteProductivityStore(directory);
  const context = createShutdownContext(Date.now() + 5_000);
  try {
    await store.execute('goal-command', { ...scope, kind: 'goal.put', goalId: 'goal', expectedVersion: null,
      title: 'Original private title', phase: 'implementation', status: 'active', roundCap: 8 }, now);
    await store.execute('todo-command', { ...scope, kind: 'todo.snapshot.replace', goalId: 'goal', expectedGoalVersion: 1,
      expectedRevision: null, items: [{ todoId: 'todo', title: 'Original task', status: 'pending' }] }, now);
    await store.execute('workflow-command', { ...scope, kind: 'workflow.start', workflowId: 'workflow', goalId: 'goal',
      expectedGoalVersion: 1, expectedTodoRevision: 1, todoIds: ['todo'], maxConcurrency: 1, maxTransitions: 8,
      ...(agent ? { executionMode: 'agent' as const } : {}),
      deadlineAt: '2098-01-01T01:00:00.000Z' }, now);
    await store.execute('schedule-command', { ...scope, kind: 'schedule.create', scheduleId: 'schedule', prompt: 'Original prompt',
      timing: { kind: 'interval', intervalMs: 1_000 } }, now);
    await store.materializeDue(new Date(now.getTime() + 1_000));
    if (agent) await store.claimWorkflowAgentTask('workflow', 'todo', now);
  } finally { await store.close(context); context.dispose(); }
  const database = new DatabaseSync(path.join(directory, DATABASE_PATHS.productivity)); databases.push(database);
  // Reconstruct the released V2 source, retaining byte-exact original business
  // rows. The current opener creates V3; this fixture has no fault metadata.
  expect(database.prepare('SELECT count(*) AS count FROM productivity_task_faults').get()!.count).toBe(0);
  database.exec('DROP TABLE productivity_task_faults; PRAGMA user_version=2;');
  const backupRoot = path.join(directory, path.dirname(DATABASE_PATHS.productivity), 'migration-backups');
  if (!path.resolve(backupRoot).startsWith(path.resolve(directory) + path.sep)) throw new Error('fixture_backup_scope_invalid');
  rmSync(backupRoot, { recursive: true, force: true });
  return database;
}
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  const temporary = path.resolve(tmpdir()) + path.sep;
  for (const directory of roots.splice(0)) {
    if (!path.resolve(directory).startsWith(temporary) || !path.basename(directory).startsWith('AriadneTaskIsolationAudit-')) throw new Error('test_cleanup_scope_invalid');
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('task-isolation source and additive-schema preparation', () => {
  it('declares the exact additive production layout without replacing the released V2 baseline', async () => {
    const source = await fixture(), directory = roots.at(-1)!;
    migrateProductivityTaskIsolationV2ToV3(directory, now);
    const manifest = JSON.parse(readFileSync(new URL('../config/productivity-task-isolation-layout-v3.json', import.meta.url), 'utf8'));
    expect(manifest.relativePath).toBe(DATABASE_PATHS.productivity);
    expect(manifest.schemaMetadataVersion).toBe(3);
    expect(manifest.schemaDigest).toBe(PRODUCTIVITY_TASK_ISOLATION_SCHEMA_V3_DIGEST);
    const schema = source.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
      .all().map(row => ({ ...row, sql: typeof row.sql === 'string' ? row.sql.replace(/\s+/gu, ' ').trim() : null }));
    expect(manifest.tables).toEqual(schema.filter(row => row.type === 'table').map(row => row.name));
    expect(manifest.schemaDigest).toBe(`sha256:${createHash('sha256').update(JSON.stringify(schema)).digest('hex')}`);
    const baseline = JSON.parse(readFileSync(new URL('../config/database-layout.json', import.meta.url), 'utf8'));
    expect(baseline.owners.find((owner: { owner: string }) => owner.owner === 'productivity').schemaMetadataVersion).toBe(2);
  });
  it('audits actual original business rows, receipts and occurrence identities without rewriting them', async () => {
    const database = await fixture();
    const before = auditProductivityAuthorityV2(database);
    expect(before.records).toBe(13);
    expect(auditProductivityAuthorityV2(database)).toEqual(before);
    expect(database.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 2 });
  });
  it.each(['binding', 'receipt', 'occurrence'] as const)('rejects %s corruption before any new task table exists', async corruption => {
    const database = await fixture();
    if (corruption === 'binding') database.exec("UPDATE productivity_goals SET workspace_id='different-owner'");
    if (corruption === 'receipt') database.exec("UPDATE productivity_commands SET result_json='{}' WHERE command_id='goal-command'");
    if (corruption === 'occurrence') database.exec("UPDATE productivity_schedule_occurrences SET command_id='different-command'");
    expect(() => auditProductivityAuthorityV2(database)).toThrow();
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name='productivity_task_faults'").get()).toBeUndefined();
  });
  it('rolls back additive fault metadata and preserves the exact source proof on interruption', async () => {
    const database = await fixture(), before = auditProductivityAuthorityV2(database);
    expect(() => addProductivityTaskIsolationSchemaV3(database)).toThrow('upgrade_boundary_invalid');
    database.exec('BEGIN IMMEDIATE;');
    try {
      addProductivityTaskIsolationSchemaV3(database);
      expect(database.prepare("SELECT name FROM sqlite_master WHERE name='productivity_task_faults'").get()).toBeDefined();
      // No business row, task state or schema-version publication has happened.
      expect(database.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 2 });
    } finally { database.exec('ROLLBACK;'); }
    expect(auditProductivityAuthorityV2(database)).toEqual(before);
  });
  it('rejects a changed physical source layout and keeps source rows intact', async () => {
    const database = await fixture();
    const receipt = database.prepare('SELECT result_json FROM productivity_commands WHERE command_id=?').get('goal-command');
    database.exec('CREATE TABLE unexpected_authority(value TEXT)');
    expect(() => auditProductivityAuthorityV2(database)).toThrow('productivity_authority_audit:schema');
    expect(database.prepare('SELECT result_json FROM productivity_commands WHERE command_id=?').get('goal-command')).toEqual(receipt);
  });
  it('publishes only audited additive Schema 3, verifies the original backup and restores the current Schema 2 authority', async () => {
    const source = await fixture(), directory = roots.at(-1)!, before = auditProductivityAuthorityV2(source);
    const result = migrateProductivityTaskIsolationV2ToV3(directory, now);
    expect(result).toMatchObject({ migrated: true, fromVersion: 2, toVersion: 3, sourceDigest: before.digest, records: 13 });
    expect(source.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 3 });
    expect(migrateProductivityTaskIsolationV2ToV3(directory, now)).toMatchObject({ migrated: false, fromVersion: 3, records: 13 });
    const backup = new DatabaseSync(result.backupPath!, { readOnly: true });
    try { expect(auditProductivityAuthorityV2(backup)).toEqual(before); }
    finally { backup.close(); }
    const current = new SqliteProductivityStore(directory), currentContext = createShutdownContext(Date.now() + 5_000);
    try { expect((await current.query(scope.workspaceId, scope.sessionId)).goal?.title).toBe('Original private title'); }
    finally { await current.close(currentContext); currentContext.dispose(); }
    const restoredRoot = mkdtempSync(path.join(tmpdir(), 'AriadneTaskIsolationAudit-')); roots.push(restoredRoot);
    const restoredFile = path.join(restoredRoot, DATABASE_PATHS.productivity); mkdirSync(path.dirname(restoredFile), { recursive: true });
    copyFileSync(result.backupPath!, restoredFile);
    const restored = new SqliteProductivityStore(restoredRoot), context = createShutdownContext(Date.now() + 5_000);
    try { expect((await restored.query(scope.workspaceId, scope.sessionId)).goal?.title).toBe('Original private title'); }
    finally { await restored.close(context); context.dispose(); }
    const reader = new DatabaseSync(restoredFile, { readOnly: true });
    try {
      expect(reader.prepare('PRAGMA user_version').get()!.user_version).toBe(3);
      expect(auditProductivityAuthorityRecords(reader)).toEqual(before);
    }
    finally { reader.close(); }
  });
  it('rolls back DDL, source mutation and version when post-add verification fails, then safely reuses the verified backup', async () => {
    const source = await fixture(), directory = roots.at(-1)!, before = auditProductivityAuthorityV2(source);
    expect(() => migrateProductivityTaskIsolationV2ToV3(directory, now, { afterAddSchema: owned => {
      owned.prepare("UPDATE productivity_goals SET goal_json='{}'").run();
    } })).toThrow('goal_execution_authority_invalid');
    expect(auditProductivityAuthorityV2(source)).toEqual(before);
    expect(source.prepare("SELECT name FROM sqlite_master WHERE name='productivity_task_faults'").get()).toBeUndefined();
    expect(migrateProductivityTaskIsolationV2ToV3(directory, now)).toMatchObject({ migrated: true, records: 13 });
  });
  it('refuses corrupted or newer sources without backup creation or rewriting their bytes', async () => {
    const source = await fixture(), directory = roots.at(-1)!, file = path.join(directory, DATABASE_PATHS.productivity);
    source.exec('PRAGMA user_version=4; PRAGMA wal_checkpoint(TRUNCATE);');
    const bytes = readFileSync(file);
    expect(() => migrateProductivityTaskIsolationV2ToV3(directory, now)).toThrow('productivity_task_isolation_source_unsupported:4');
    expect(readFileSync(file)).toEqual(bytes);
    expect(existsSync(path.join(path.dirname(file), 'migration-backups'))).toBe(false);
    source.exec("PRAGMA user_version=2; UPDATE productivity_commands SET result_json='{}';");
    expect(() => migrateProductivityTaskIsolationV2ToV3(directory, now)).toThrow();
    expect(existsSync(path.join(path.dirname(file), 'migration-backups'))).toBe(false);
  });
  it('detects outside source changes after backup, preserves that change and refuses to publish mismatched DDL', async () => {
    const source = await fixture(), directory = roots.at(-1)!;
    expect(() => migrateProductivityTaskIsolationV2ToV3(directory, now, { beforeFinalTransaction: () => {
      const row = source.prepare('SELECT goal_json FROM productivity_goals').get() as { goal_json: string };
      const goal = JSON.parse(row.goal_json); goal.title = 'Outside authorized change';
      source.prepare('UPDATE productivity_goals SET goal_json=?').run(JSON.stringify(goal));
    } })).toThrow('productivity_task_isolation_source_changed');
    expect(source.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 2 });
    expect(source.prepare("SELECT name FROM sqlite_master WHERE name='productivity_task_faults'").get()).toBeUndefined();
    expect(JSON.parse((source.prepare('SELECT goal_json FROM productivity_goals').get() as { goal_json: string }).goal_json).title)
      .toBe('Outside authorized change');
    expect(() => migrateProductivityTaskIsolationV2ToV3(directory, now)).toThrow('productivity_task_isolation_source_changed');
    expect(migrateProductivityTaskIsolationV2ToV3(directory, new Date(now.getTime() + 1))).toMatchObject({ migrated: true });
  });
  it('quarantines only fault metadata against original immutable task identity, preserves business outcome and survives reopening', async () => {
    const source = await fixture(true), directory = roots.at(-1)!, before = auditProductivityAuthorityV2(source);
    migrateProductivityTaskIsolationV2ToV3(directory, now);
    const faults = new SqliteProductivityTaskIsolation(source);
    expect(() => faults.quarantine('workflow', 'workflow', 'todo', 'task_authority_conflict', now)).toThrow('transaction_required');
    source.exec('BEGIN IMMEDIATE;');
    let fault;
    try {
      fault = faults.quarantine('workflow', 'workflow', 'todo', 'task_authority_conflict', now);
      expect(fault).toMatchObject({ taskKind: 'workflow', entityId: 'workflow', taskId: 'todo', ownerSessionId: scope.sessionId,
        state: 'quarantined', revision: 1, code: 'task_authority_conflict' });
      expect(faults.quarantine('workflow', 'workflow', 'todo', 'result_authority_conflict', new Date(now.getTime() + 1))).toEqual(fault);
      source.exec('COMMIT;');
    } catch (error) { if (source.isTransaction) source.exec('ROLLBACK;'); throw error; }
    const body = JSON.parse((source.prepare('SELECT workflow_json FROM productivity_workflows').get() as { workflow_json: string }).workflow_json);
    expect(body.agentExecution.tasks[0].status).toBe('claimed');
    expect(body.status).toBe('running');
    expect(faults.isQuarantined('workflow', 'workflow', 'todo')).toBe(true);
    expect(faults.query(scope.workspaceId, scope.sessionId, 32).faults).toEqual([fault]);
    expect(faults.query('other-workspace', scope.sessionId, 32).faults).toEqual([]);
    expect(JSON.stringify(fault)).not.toContain('Original task');
    expect(migrateProductivityTaskIsolationV2ToV3(directory, now)).toMatchObject({ migrated: false, records: before.records, sourceDigest: before.digest });
    const reopened = new DatabaseSync(path.join(directory, DATABASE_PATHS.productivity), { readOnly: true });
    try { expect(new SqliteProductivityTaskIsolation(reopened).query(scope.workspaceId, scope.sessionId, 32).faults).toEqual([fault]); }
    finally { reopened.close(); }
  });
  it.each(['submit_command_id', 'state'] as const)('rolls back quarantine alone and refuses corrupted fault %s during query and re-open audit', async changed => {
    const source = await fixture(true), directory = roots.at(-1)!; migrateProductivityTaskIsolationV2ToV3(directory, now);
    const faults = new SqliteProductivityTaskIsolation(source);
    source.exec('BEGIN IMMEDIATE;'); faults.quarantine('workflow', 'workflow', 'todo', 'task_authority_conflict', now); source.exec('ROLLBACK;');
    expect(faults.isQuarantined('workflow', 'workflow', 'todo')).toBe(false);
    source.exec('BEGIN IMMEDIATE;'); faults.quarantine('workflow', 'workflow', 'todo', 'task_authority_conflict', now); source.exec('COMMIT;');
    if (changed === 'state') source.exec("UPDATE productivity_task_faults SET state='resolved'");
    else source.exec("UPDATE productivity_task_faults SET submit_command_id='different-command'");
    expect(() => faults.query(scope.workspaceId, scope.sessionId, 32)).toThrow('productivity_task_fault_storage:identity');
    expect(() => migrateProductivityTaskIsolationV2ToV3(directory, now)).toThrow('productivity_task_fault_storage:identity');
  });
  it('keeps an unknown Schedule occurrence pending and pages body-free faults under the parent owner scope', async () => {
    const source = await fixture(true), directory = roots.at(-1)!; migrateProductivityTaskIsolationV2ToV3(directory, now);
    const faults = new SqliteProductivityTaskIsolation(source);
    const occurrence = source.prepare('SELECT occurrence_id FROM productivity_schedule_occurrences').get() as { occurrence_id: string };
    source.exec('BEGIN IMMEDIATE;');
    try {
      faults.quarantine('workflow', 'workflow', 'todo', 'task_authority_conflict', now);
      expect(faults.quarantine('schedule', 'schedule', occurrence.occurrence_id, 'submission_identity_conflict', now))
        .toMatchObject({ sessionId: scope.sessionId, ownerSessionId: scope.sessionId, state: 'quarantined' });
      source.exec('COMMIT;');
    } catch (error) { if (source.isTransaction) source.exec('ROLLBACK;'); throw error; }
    expect(source.prepare('SELECT status,attempts FROM productivity_schedule_occurrences').get()).toMatchObject({ status: 'pending', attempts: 0 });
    const first = faults.query(scope.workspaceId, scope.sessionId, 1);
    expect(first.faults).toHaveLength(1); expect(first.nextFaultId).toBe(first.faults[0]!.faultId);
    const second = faults.query(scope.workspaceId, scope.sessionId, 1, first.nextFaultId!);
    expect(second.faults).toHaveLength(1); expect(second.nextFaultId).toBeNull();
    expect(first.faults[0]!.faultId).not.toBe(second.faults[0]!.faultId);
    expect(JSON.stringify([...first.faults, ...second.faults])).not.toMatch(/Original prompt|Original task|submitCommandId|messageId/u);
    expect(faults.audit()).toBe(2);
  });
  it('fences stale and interrupted recovery claims while leaving business state unchanged', async () => {
    const source = await fixture(true), directory = roots.at(-1)!; migrateProductivityTaskIsolationV2ToV3(directory, now);
    const faults = new SqliteProductivityTaskIsolation(source);
    source.exec('BEGIN IMMEDIATE;');
    const fault = faults.quarantine('workflow', 'workflow', 'todo', 'task_authority_conflict', now)!;
    source.exec('COMMIT;');
    source.exec('BEGIN IMMEDIATE;');
    const first = faults.beginReconcile(scope.workspaceId, scope.sessionId, fault.faultId, 1, now);
    source.exec('COMMIT;');
    expect(first.fault).toMatchObject({ state: 'reconciling', revision: 2 });
    expect(faults.isQuarantined('workflow', 'workflow', 'todo')).toBe(true);
    // An explicit new revision can reclaim a crashed read-only reconciliation.
    source.exec('BEGIN IMMEDIATE;');
    const replacement = faults.beginReconcile(scope.workspaceId, scope.sessionId, fault.faultId, 2, now);
    source.exec('COMMIT;');
    source.exec('BEGIN IMMEDIATE;');
    expect(() => faults.finishReconcile(scope.workspaceId, scope.sessionId, fault.faultId, 2, first.sourceDigest, true, now))
      .toThrow('recovery_conflict');
    source.exec('ROLLBACK;');
    source.exec('BEGIN IMMEDIATE;');
    expect(faults.finishReconcile(scope.workspaceId, scope.sessionId, fault.faultId, 3, replacement.sourceDigest, false, now))
      .toMatchObject({ state: 'quarantined', revision: 4 });
    source.exec('COMMIT;');
    const record = JSON.parse(String(source.prepare('SELECT workflow_json FROM productivity_workflows').get()!.workflow_json));
    expect(record.agentExecution.tasks[0].status).toBe('claimed'); expect(record.results).toEqual([]);
    expect(faults.audit()).toBe(1);
  });
});

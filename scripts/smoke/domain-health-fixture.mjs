import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteProductivityStore } from '../../runtime/dist/adapters/persistence/SqliteProductivityStore.js';
import { SqliteLongMemoryStore } from '../../runtime/dist/adapters/persistence/SqliteLongMemoryStore.js';
import { SqliteRuntimeCommandJournal } from '../../runtime/dist/adapters/persistence/SqliteRuntimeCommandJournal.js';
import { createShutdownContext } from '../../runtime/dist/ingress/ShutdownContext.js';
import { SqliteConversationRunHandoffUnitOfWork } from '../../runtime/dist/adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import { ConversationAuthorityService } from '../../runtime/dist/control/conversation/ConversationAuthorityService.js';
import { openConversationDatabase } from '../../runtime/dist/adapters/persistence/ConversationDbSchema.js';
import { openAgentControlDatabase } from '../../runtime/dist/adapters/persistence/agentControlDbSchema.js';
import { openPublicProjectionDatabase } from '../../runtime/dist/adapters/persistence/PublicProjectionDbSchema.js';
import { SqlitePublicProjectionStore } from '../../runtime/dist/adapters/persistence/SqlitePublicProjectionStore.js';
import { closeOwnedSqliteDatabase } from '../../runtime/dist/adapters/persistence/SqliteOwnerLease.js';
import { ModelCapabilityRegistry, qualificationDatabasePath } from '../../runtime/dist/model/capability/ModelCapabilityRegistry.js';
import { unknownQualification } from '../../runtime/dist/model/capability/ModelCapabilityQualification.js';
import { auditModelCapabilityAuthority } from '../../runtime/dist/model/capability/ModelCapabilityRecords.js';

const [input, workspaceId, output, scenario = 'source'] = process.argv.slice(2);
assert(input && workspaceId && output && path.isAbsolute(input) && path.isAbsolute(output), 'domain_health_fixture_arguments');
const root = realpathSync.native(input), relative = path.relative(realpathSync.native(tmpdir()), root);
assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(root).startsWith('AriadneDomainHealth-'), 'domain_health_fixture_temp_scope');
assert(['source', 'memory', 'memory-model', 'journal', 'execution', 'conversation', 'projection', 'inference', 'inference-local', 'inference-remote', 'task', 'task-resume', 'verify-task', 'verify-inference-local'].includes(scenario), 'domain_health_fixture_scenario');
if (scenario === 'verify-inference-local') {
  const fixture = JSON.parse(readFileSync(path.join(output, 'fixture.json'), 'utf8'));
  assert.equal(fixture.scenario, 'inference-local'); assert.equal(fixture.root, root); assert.equal(fixture.workspaceId, workspaceId);
  const modelRelative = path.relative(root, realpathSync.native(fixture.modelPath));
  assert(modelRelative && !modelRelative.startsWith('..') && !path.isAbsolute(modelRelative), 'model_fixture_outside_root');
  assert.equal(createHash('sha256').update(readFileSync(fixture.modelPath)).digest('hex'), fixture.originalModelSha256);
  const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
  try {
    database.exec('BEGIN'); auditModelCapabilityAuthority(database);
    const rows = database.prepare('SELECT report_json FROM model_capability_qualification WHERE provider_id=? AND model_id=?')
      .all('ariadne.local', 't03-broken-local');
    assert.equal(rows.length, 1); const report = JSON.parse(rows[0].report_json);
    assert.equal(report.textResponse, 'rejected'); assert.equal(report.failureCode, 'model_probe_failed');
    database.exec('ROLLBACK');
  } finally { database.close(); }
  process.exit(0);
}
if (scenario === 'verify-task') {
  const fixture = JSON.parse(readFileSync(path.join(output, 'fixture.json'), 'utf8'));
  assert(['task','task-resume'].includes(fixture.scenario)); assert.equal(fixture.root, root); assert.equal(fixture.workspaceId, workspaceId);
  const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
  let receipts;
  try {
    assert.equal(taskBusinessDigest(database), fixture.originalTaskBusinessDigest, 'original_task_business_changed');
    receipts = database.prepare("SELECT command_id,result_json FROM productivity_commands WHERE command_id LIKE 'task-recovery-%' ORDER BY command_id").all();
    assert(receipts.length === 1 || receipts.length === 2, 'unexpected_recovery_commands');
    for (const row of receipts) { const receipt = JSON.parse(row.result_json);
      assert.equal(receipt.phase, 'completed'); assert.equal(receipt.result.outcome, 'unresolved'); assert.equal(receipt.result.fault.state, 'quarantined'); }
    const fault = database.prepare('SELECT revision,state FROM productivity_task_faults WHERE fault_id=?').get(fixture.fault.faultId);
    assert.equal(fault.state, 'quarantined'); assert.equal(fault.revision, 1 + 2 * receipts.length);
  } finally { database.close(); }
  const conversation = new DatabaseSync(path.join(root, 'runtime/data/conversation/conversation.db'), { readOnly: true });
  try {
    assert.equal(conversation.prepare('SELECT count(*) AS count FROM conversation_sessions WHERE session_id=?').get(fixture.taskSessionId).count, 0, 'recovery_created_task_session');
    assert.equal(conversation.prepare('SELECT count(*) AS count FROM conversation_handoff_sagas WHERE message_id=?').get(fixture.taskMessageId).count, 0, 'recovery_created_task_saga');
  } finally { conversation.close(); }
  writeFileSync(path.join(output, `task-effects-proof-${receipts.length}.json`), JSON.stringify({ passed: true,
    originalTaskBusinessRetained: true, originalTaskSessionAbsent: true, originalTaskSagaAbsent: true, completedRecoveryReceipts: receipts.length }, null, 2));
  process.exit(0);
}
assert(!existsSync(path.join(root, 'runtime')) && readdirSync(root).every(name => name === 'workspace'), 'domain_health_fixture_fresh_root_required');
const runtimeRoot = path.join(root, 'runtime');
if (scenario === 'inference-remote') {
  const databasePath = qualificationDatabasePath(runtimeRoot), registry = new ModelCapabilityRegistry(databasePath); registry.close();
  mkdirSync(output, { recursive: true }); writeFileSync(path.join(output, 'fixture.json'), JSON.stringify({
    format: 'ariadne-domain-health-fixture.v1', scenario, root, workspaceId, databasePath }, null, 2));
  process.exit(0);
}
if (scenario === 'inference-local') {
  const modelDirectory = path.join(root, 'workspace', 'models', 'broken'), modelPath = path.join(modelDirectory, 'broken.gguf');
  mkdirSync(modelDirectory, { recursive: true }); writeFileSync(modelPath, Buffer.from([1, 2, 3]));
  writeFileSync(path.join(modelDirectory, 'model.json'), JSON.stringify({ id: 't03-broken-local', displayName: '【验收夹具】不可用的本地模型',
    runtime: 'llama.cpp', modelFile: 'broken.gguf', contextSize: 8192, gpuLayers: 0, device: 'cpu', timeoutMs: 30000 }));
  const databasePath = qualificationDatabasePath(runtimeRoot), registry = new ModelCapabilityRegistry(databasePath); registry.close();
  mkdirSync(output, { recursive: true }); writeFileSync(path.join(output, 'fixture.json'), JSON.stringify({
    format: 'ariadne-domain-health-fixture.v1', scenario, root, workspaceId, databasePath, modelPath,
    originalModelSha256: createHash('sha256').update(readFileSync(modelPath)).digest('hex') }, null, 2));
  process.exit(0);
}
if (scenario === 'inference') {
  const databasePath = qualificationDatabasePath(runtimeRoot), registry = new ModelCapabilityRegistry(databasePath);
  try { registry.write(unknownQualification({ providerId: 'fixture-only', modelId: 'fixture-only', fingerprint: `sha256:${'a'.repeat(64)}` })); }
  finally { registry.close(); }
  const database = new DatabaseSync(databasePath);
  try { database.prepare('UPDATE model_capability_qualification SET report_json=?').run(JSON.stringify({ private: 'PRIVATE_TASK_SOURCE_MARKER_DO_NOT_RENDER' }));
    database.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } finally { database.close(); }
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, 'fixture.json'), JSON.stringify({ format: 'ariadne-domain-health-fixture.v1', scenario, root, workspaceId,
    databasePath, corruptSourceSha256: createHash('sha256').update(readFileSync(databasePath)).digest('hex') }, null, 2));
  process.exit(0);
}
if (['execution', 'conversation', 'projection'].includes(scenario)) {
  if (scenario === 'projection') {
    const store = new SqlitePublicProjectionStore(runtimeRoot), time = '2032-01-01T00:00:00.000Z';
    try { await store.append({ contractVersion: '5.0', eventId: 'original-event', sourceId: 'original-source', sourceCursor: 1,
      occurredAt: time, changes: [{ feature: 'sessions', aggregateId: 'original-session', aggregateVersion: 1,
        operation: 'upsert', projectedAt: time, dto: { sessionId: 'original-session', workspaceId,
          title: 'PRIVATE_TASK_SOURCE_MARKER_DO_NOT_RENDER', pinned: false, status: 'active', createdAt: time, updatedAt: time, version: 1 } }] }); }
    finally { await store.close(); }
  }
  const opened = ({ execution: openAgentControlDatabase, conversation: openConversationDatabase,
    projection: openPublicProjectionDatabase })[scenario](runtimeRoot), databasePath = opened.databasePath;
  try {
    if (scenario === 'projection') opened.database.prepare('UPDATE projection_commits SET commit_json=?').run(JSON.stringify({ private: 'PRIVATE_TASK_SOURCE_MARKER_DO_NOT_RENDER' }));
    else opened.database.exec('CREATE VIEW foreign_private_schema AS SELECT 1;');
    opened.database.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } finally { closeOwnedSqliteDatabase(opened.database, opened.ownerLease); }
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, 'fixture.json'), JSON.stringify({ format: 'ariadne-domain-health-fixture.v1', scenario, root, workspaceId,
    databasePath, corruptSourceSha256: createHash('sha256').update(readFileSync(databasePath)).digest('hex') }, null, 2));
  process.exit(0);
}
if (scenario === 'journal') {
  const journal = new SqliteRuntimeCommandJournal(); journal.open(runtimeRoot);
  try { journal.begin('domain-health-original-journal', 'a'.repeat(64));
    journal.complete('domain-health-original-journal', 'a'.repeat(64), { ok: true, result: { kind: 'acknowledged' } });
  } finally { journal.close(); }
  const databasePath = path.join(runtimeRoot, 'data/runtime-control/runtime-command.db'), database = new DatabaseSync(databasePath);
  try { database.prepare('UPDATE runtime_commands SET outcome_json=?').run(JSON.stringify({ private: 'PRIVATE_TASK_SOURCE_MARKER_DO_NOT_RENDER' }));
    database.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } finally { database.close(); }
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, 'fixture.json'), JSON.stringify({ format: 'ariadne-domain-health-fixture.v1', scenario, root, workspaceId,
    databasePath, corruptSourceSha256: createHash('sha256').update(readFileSync(databasePath)).digest('hex') }, null, 2));
  process.exit(0);
}
if (scenario === 'memory' || scenario === 'memory-model') {
  const memory = new SqliteLongMemoryStore(runtimeRoot), shutdown = createShutdownContext(Date.now() + 5000);
  try {
    await memory.execute('domain-health-original-memory', { kind: 'memory.put', contractVersion: '5.0', workspaceId,
      sessionId: 'domain-health-original-session', memoryId: 'domain-health-original-memory', expectedVersion: null,
      scope: 'workspace', memoryType: 'fact', title: 'PRIVATE_TASK_SOURCE_MARKER_DO_NOT_RENDER',
      content: 'PRIVATE_TASK_SOURCE_MARKER_DO_NOT_RENDER', importance: 0.8, confidence: 1, sensitivity: 'workspace', retentionUntil: null });
  } finally { await memory.close(shutdown); shutdown.dispose(); }
  const databasePath = path.join(runtimeRoot, 'data/long-memory/long-memory.db'), database = new DatabaseSync(databasePath);
  try { if (scenario === 'memory') database.prepare('UPDATE long_memories SET payload_json=?').run(JSON.stringify({ private: 'PRIVATE_TASK_SOURCE_MARKER_DO_NOT_RENDER' }));
    database.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } finally { database.close(); }
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, 'fixture.json'), JSON.stringify({ format: 'ariadne-domain-health-fixture.v1', scenario, root, workspaceId,
    databasePath, corruptSourceSha256: createHash('sha256').update(readFileSync(databasePath)).digest('hex') }, null, 2));
  process.exit(0);
}
const store = new SqliteProductivityStore(runtimeRoot);
const shutdown = createShutdownContext(Date.now() + 5000);
if (scenario === 'task' || scenario === 'task-resume') {
  const sessionId = 'domain-health-task-parent', scope = { contractVersion: '5.0', workspaceId, sessionId };
  const conversation = new SqliteConversationRunHandoffUnitOfWork(runtimeRoot);
  let fault, task;
  try {
    await new ConversationAuthorityService(conversation).createSession({ kind: 'conversation.create_session', commandId: 'domain-health-parent-create',
      eventId: 'domain-health-parent-event', workspaceId, sessionId, expectedVersion: null, occurredAt: new Date().toISOString() });
    await store.execute('domain-health-task-goal', { ...scope, kind: 'goal.put', goalId: 'domain-health-task-goal', expectedVersion: null,
      title: '【验收夹具】原任务隔离', phase: 'implementation', status: 'active', roundCap: 8 });
    await store.execute('domain-health-task-todos', { ...scope, kind: 'todo.snapshot.replace', goalId: 'domain-health-task-goal', expectedGoalVersion: 1,
      expectedRevision: null, items: [{ todoId: 'domain-health-isolated-task', title: '【验收夹具】证据未确认的任务', status: 'pending' }] });
    await store.execute('domain-health-task-start', { ...scope, kind: 'workflow.start', workflowId: 'domain-health-task-workflow',
      goalId: 'domain-health-task-goal', expectedGoalVersion: 1, expectedTodoRevision: 1, todoIds: ['domain-health-isolated-task'],
      maxConcurrency: 1, maxTransitions: 8, deadlineAt: '2098-01-01T00:00:00.000Z', executionMode: 'agent' });
    task = await store.claimWorkflowAgentTask('domain-health-task-workflow', 'domain-health-isolated-task');
    fault = await store.quarantineTask('workflow', 'domain-health-task-workflow', task.todoId, 'task_authority_conflict');
    if (scenario === 'task-resume') {
      await store.beginTaskRecoveryCommand('task-recovery-prestarted', { kind: 'productivity.task.reconcile', contractVersion: '1.0',
        workspaceId, sessionId, faultId: fault.faultId, expectedRevision: fault.revision });
      fault = (await store.queryTaskFaults(workspaceId, sessionId, 32)).faults[0];
    }
  } finally { await store.close(shutdown); await conversation.close(shutdown); shutdown.dispose(); }
  const databasePath = path.join(runtimeRoot, 'data/productivity/productivity.db'), database = new DatabaseSync(databasePath, { readOnly: true });
  let originalTaskBusinessDigest;
  try { originalTaskBusinessDigest = taskBusinessDigest(database); } finally { database.close(); }
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, 'fixture.json'), JSON.stringify({ format: 'ariadne-domain-health-fixture.v1', scenario, root, workspaceId,
    databasePath, fault, originalTaskBusinessDigest, taskSessionId: task.sessionId, taskMessageId: task.messageId }, null, 2));
  process.exit(0);
}
try {
  await store.execute('domain-health-original-goal', { kind: 'goal.put', contractVersion: '5.0', workspaceId,
    sessionId: 'domain-health-original-session', goalId: 'domain-health-original-goal', expectedVersion: null,
    title: 'PRIVATE_TASK_SOURCE_MARKER_DO_NOT_RENDER', phase: 'implementation', status: 'active', roundCap: 2 });
} finally { await store.close(shutdown); shutdown.dispose(); }
const databasePath = path.join(runtimeRoot, 'data/productivity/productivity.db'), database = new DatabaseSync(databasePath);
try {
  database.prepare('UPDATE productivity_goals SET goal_json=?').run(JSON.stringify({ private: 'PRIVATE_TASK_SOURCE_MARKER_DO_NOT_RENDER' }));
  database.exec('PRAGMA wal_checkpoint(TRUNCATE);');
} finally { database.close(); }
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, 'fixture.json'), JSON.stringify({ format: 'ariadne-domain-health-fixture.v1', root, workspaceId, databasePath,
  corruptSourceSha256: createHash('sha256').update(readFileSync(databasePath)).digest('hex') }, null, 2));

function taskBusinessDigest(database) {
  const hash = createHash('sha256');
  for (const [table, key] of [['productivity_goals','goal_id'],['productivity_todo_snapshots','goal_id'],['productivity_workflows','workflow_id'],
    ['productivity_schedules','schedule_id'],['productivity_schedule_occurrences','occurrence_id'],['productivity_events','cursor']]) {
    for (const row of database.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).iterate()) hash.update(table + '\0' + JSON.stringify(row) + '\n');
  }
  for (const row of database.prepare("SELECT * FROM productivity_commands WHERE command_id NOT LIKE 'task-recovery-%' AND command_id NOT LIKE 'task-claim-%' ORDER BY command_id").iterate())
    hash.update('productivity_commands\0' + JSON.stringify(row) + '\n');
  return hash.digest('hex');
}

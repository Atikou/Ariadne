import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ARIADNE_RUNTIME_PROTOCOL as protocol, ARIADNE_RUNTIME_PROTOCOL_VERSION as protocolVersion,
  parseRuntimeToHostMessage } from '@ariadne/protocol/host';
import { createDefaultRuntimePolicySnapshot } from '@ariadne/protocol/settings';

// Physical process gate: production entry, IPC, command owners and SQLite. No
// injected pause, prewritten recovery claim, alternate owner or execution hook.
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimePackage = path.join(repository, 'runtime');
const output = path.resolve(process.argv[2] ?? path.join(repository, 'artifacts/todo-remediation/runtime-t03-task-recovery-crash'));
assert(path.isAbsolute(output)); mkdirSync(output, { recursive: true });
const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'AriadneDomainHealth-')));
const workspace = path.join(root, 'workspace'); mkdirSync(workspace);
const workspaceId = 'workspace-' + createHash('sha256').update(workspace.toLowerCase()).digest('hex').slice(0, 20);
const seeded = spawnSync(process.execPath, [path.join(repository, 'scripts/smoke/domain-health-fixture.mjs'), root, workspaceId, output, 'task'],
  { cwd: repository, encoding: 'utf8', windowsHide: true });
writeFileSync(path.join(output, 'fixture-process.log'), (seeded.stdout ?? '') + (seeded.stderr ?? ''));
assert.equal(seeded.status, 0, 'task_fixture_failed');
const fixture = JSON.parse(readFileSync(path.join(output, 'fixture.json'), 'utf8'));
const fingerprint = JSON.parse(readFileSync(path.join(runtimePackage, 'dist/runtime-build.json'), 'utf8')).fingerprint;
const scope = { contractVersion: '1.0', workspaceId, sessionId: 'domain-health-task-parent' };
const children = new Set(); const trials = [];
let runtime, observer, gate = { passed: false, format: 'ariadne-task-recovery-physical-crash.v1', root, trials };
let serial = 0;
try {
  runtime = await startRuntime();
  observer = new DatabaseSync(fixture.databasePath, { readOnly: true });
  const select = observer.prepare('SELECT result_json FROM productivity_commands WHERE command_id=?');
  let accepted;
  for (let attempt = 1; attempt <= 32; attempt++) {
    const faults = await queryFaults(runtime);
    assert.equal(faults.length, 1); const fault = faults[0]; assert.equal(fault.state, 'quarantined');
    const commandId = `task-recovery-physical-${attempt}`;
    const command = { kind: 'productivity.task.reconcile', ...scope, faultId: fault.faultId, expectedRevision: fault.revision };
    const requestId = `physical-attempt-${attempt}`;
    const envelope = requestEnvelope(runtime, requestId, commandId, command);
    await runtime.send(envelope);
    const deadline = performance.now() + 3000; let observed, polls = 0;
    // The parent polls the actual committed WAL while the independent child
    // runs. Event-loop blocking does not establish whether ACK entered IPC.
    while (performance.now() < deadline) {
      polls++;
      try { const row = select.get(commandId); if (row !== undefined) { observed = JSON.parse(row.result_json); break; } }
      catch (error) { if (![5, 6].includes(Number(error.errcode))) throw error; }
    }
    assert(observed, 'recovery_receipt_not_observed');
    const trial = { attempt, commandId, expectedRevision: fault.revision, observedPhase: observed.phase, polls };
    trials.push(trial);
    if (observed.phase === 'reconciling') {
      assert(runtime.child.kill('SIGKILL'), 'physical_kill_failed');
      trial.exit = await runtime.exited;
      const persisted = JSON.parse(select.get(commandId).result_json); trial.persistedPhaseAfterExit = persisted.phase;
      trial.responseObservedByParent = runtime.messages.some(message => message.type === 'response' && message.requestId === requestId);
      writeFileSync(path.join(output, 'trials.json'), JSON.stringify(trials, null, 2));
      runtime = await startRuntime();
      if (persisted.phase === 'reconciling') { accepted = { commandId, command, claimRevision: observed.claimFault.revision }; break; }
      // A late kill is a recorded miss, not an accepted intermediate crash.
      const replay = await invoke(runtime, commandId, command); assert.equal(replay.outcome, 'unresolved');
    } else {
      assert.equal(observed.phase, 'completed');
      const completed = await runtime.next(message => message.type === 'response' && message.requestId === requestId);
      assert.equal(completed.outcome.ok, true);
    }
  }
  assert(accepted, 'physical_reconciling_boundary_not_captured');
  const pending = (await queryFaults(runtime))[0];
  assert.equal(pending.state, 'reconciling'); assert.equal(pending.revision, accepted.claimRevision);
  const references = await invoke(runtime, `query-claims-${++serial}`, { kind: 'productivity.task_recovery.claims.query', ...scope,
    claims: [{ faultId: pending.faultId, revision: pending.revision }] });
  assert.deepEqual(references.references, [{ faultId: pending.faultId, claimRevision: pending.revision,
    commandId: accepted.commandId, expectedRevision: accepted.command.expectedRevision }]);
  const journalPath = path.join(root, 'runtime/data/runtime-control/runtime-command.db');
  const journal = new DatabaseSync(journalPath, { readOnly: true });
  try { assert.equal(journal.prepare('SELECT status FROM runtime_commands WHERE command_id=?')
    .get(createHash('sha256').update(accepted.commandId).digest('hex')).status, 'uncertain'); } finally { journal.close(); }
  const recovered = await invoke(runtime, accepted.commandId, accepted.command);
  assert.equal(recovered.kind, 'productivity.task.reconciled'); assert.equal(recovered.outcome, 'unresolved');
  assert.equal(recovered.fault.state, 'quarantined'); assert.equal(recovered.fault.revision, accepted.claimRevision + 1);
  assert.deepEqual(await invoke(runtime, accepted.commandId, accepted.command), recovered);
  assert.equal((await queryFaults(runtime))[0].revision, recovered.fault.revision);
  // A second real kill is explicitly after response observation, not a claimed
  // COMMIT-before-ACK boundary.
  assert(runtime.child.kill('SIGKILL')); await runtime.exited;
  runtime = await startRuntime();
  assert.deepEqual(await invoke(runtime, accepted.commandId, accepted.command), recovered);
  assert.equal((await queryFaults(runtime))[0].revision, recovered.fault.revision);
  assert.equal(taskBusinessDigest(observer), fixture.originalTaskBusinessDigest, 'original_task_business_changed');
  const conversation = new DatabaseSync(path.join(root, 'runtime/data/conversation/conversation.db'), { readOnly: true });
  try {
    assert.equal(conversation.prepare('SELECT count(*) AS count FROM conversation_sessions WHERE session_id=?').get(fixture.taskSessionId).count, 0);
    assert.equal(conversation.prepare('SELECT count(*) AS count FROM conversation_handoff_sagas WHERE message_id=?').get(fixture.taskMessageId).count, 0);
  } finally { conversation.close(); }
  const receipts = observer.prepare("SELECT result_json FROM productivity_commands WHERE command_id LIKE 'task-recovery-%'").all();
  for (const row of receipts) assert.equal(JSON.parse(row.result_json).phase, 'completed');
  gate = { ...gate, passed: true, physicalReconcilingCrash: true, journalUncertainObserved: true, originalClaimReferenceRetained: true,
    originalCommandReconciled: true, replayAfterCompletedPhysicalCrash: true, originalTaskBusinessRetained: true,
    originalTaskSessionAbsent: true, originalTaskSagaAbsent: true, acceptedCommandId: accepted.commandId,
    completedRecoveryReceipts: receipts.length, finalFaultRevision: recovered.fault.revision,
    providerRequests: 0, evidenceScope: 'production Runtime Node IPC process; no Electron Main or rendered-window assertion' };
} catch (error) { gate.failure = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally {
  observer?.close();
  for (const instance of children) {
    if (instance.child.exitCode !== null || instance.child.signalCode !== null) continue;
    try { await instance.send({ protocol, protocolVersion, runtimeInstanceId: instance.id, type: 'shutdown', requestId: 'gate-shutdown',
      reason: 'user_request', deadlineAt: new Date(Date.now() + 5000).toISOString() }); }
    catch { /* Physical exit may precede IPC shutdown. */ }
    let timer; await Promise.race([instance.exited, new Promise(resolve => { timer = setTimeout(resolve, 6000); })]); clearTimeout(timer);
    if (instance.child.exitCode === null && instance.child.signalCode === null) { instance.child.kill('SIGKILL'); await instance.exited; }
  }
  writeFileSync(path.join(output, 'gate.json'), JSON.stringify(gate, null, 2));
  console.log(JSON.stringify({ passed: gate.passed, failure: gate.failure, attempts: trials.length, output }));
}

async function startRuntime() {
  const id = randomUUID();
  const child = fork(path.join(runtimePackage, 'dist/entry/runtime-process.js'), [], { cwd: runtimePackage, windowsHide: true,
    env: { ...process.env, AGENT_PROFILE: 'local-only' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let diagnostic = ''; const messages = []; const waiters = new Set();
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    writeFileSync(path.join(output, `runtime-${id}.log`), diagnostic); resolve({ code, signal }); for (const wake of waiters) wake();
  }));
  child.stdout.on('data', data => { diagnostic += data.toString(); }); child.stderr.on('data', data => { diagnostic += data.toString(); });
  child.on('message', raw => { try { messages.push(parseRuntimeToHostMessage(raw)); } catch { diagnostic += '\ninvalid_runtime_frame'; }
    for (const wake of waiters) wake(); });
  const instance = { id, child, exited, messages,
    send: message => new Promise((resolve, reject) => child.send(message, error => error ? reject(error) : resolve())),
    next: async predicate => {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const index = messages.findIndex(predicate); if (index >= 0) return messages.splice(index, 1)[0];
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('runtime_exited_before_expected_response');
        await new Promise(resolve => { const wake = () => { clearTimeout(timer); waiters.delete(wake); resolve(); };
          const timer = setTimeout(wake, 25); waiters.add(wake); });
      }
      throw new Error('runtime_expected_response_timeout');
    }
  };
  children.add(instance);
  await instance.send({ protocol, protocolVersion, runtimeInstanceId: id, type: 'bootstrap', appVersion: '0.1.0', runtimeVersion: '0.1.0',
    runtimeBuildFingerprint: fingerprint, installRoot: runtimePackage, dataRoot: path.join(root, 'runtime'), modelRoots: [], modelProviders: [],
    agentAdmissionAuthoritySource: { sourceVersion: 1, status: 'disabled', reason: 'not_configured' },
    runtimePolicy: createDefaultRuntimePolicySnapshot(), profile: 'default',
    workspaces: [{ workspaceId, label: '【验收夹具】恢复中断', rootPath: workspace, access: 'write' }], production: false });
  await instance.next(message => message.type === 'ready'); return instance;
}
function requestEnvelope(instance, requestId, commandId, command) {
  return { protocol, protocolVersion, runtimeInstanceId: instance.id, type: 'request', requestId, commandId, command,
    deadlineAt: new Date(Date.now() + 30000).toISOString() };
}
async function invoke(instance, commandId, command) {
  const requestId = `gate-request-${++serial}`; await instance.send(requestEnvelope(instance, requestId, commandId, command));
  const reply = await instance.next(message => message.type === 'response' && message.requestId === requestId);
  assert.equal(reply.outcome.ok, true, reply.outcome.error?.code); return reply.outcome.result;
}
async function queryFaults(instance) {
  return (await invoke(instance, `query-faults-${++serial}`, { kind: 'productivity.task_faults.query', ...scope, limit: 32 })).faults;
}
function taskBusinessDigest(database) {
  const hash = createHash('sha256');
  for (const [table, key] of [['productivity_goals','goal_id'],['productivity_todo_snapshots','goal_id'],['productivity_workflows','workflow_id'],
    ['productivity_schedules','schedule_id'],['productivity_schedule_occurrences','occurrence_id'],['productivity_events','cursor']])
    for (const row of database.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).iterate()) hash.update(table + '\0' + JSON.stringify(row) + '\n');
  for (const row of database.prepare("SELECT * FROM productivity_commands WHERE command_id NOT LIKE 'task-recovery-%' AND command_id NOT LIKE 'task-claim-%' ORDER BY command_id").iterate())
    hash.update('productivity_commands\0' + JSON.stringify(row) + '\n');
  return hash.digest('hex');
}

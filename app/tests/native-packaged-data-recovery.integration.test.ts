import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { unpackBackupBundle, removeOwnedBackupStage } from '../src/main/data-management/backup-bundle';
import { buildVerifiedRestoreCandidate } from '../src/main/data-management/restore-candidate';
import { prepareDataRootSwitch, settleDataRootSwitch, archiveSettledDataRootSwitch } from '../src/main/data-management/data-root-switch-journal';
import { validateBackupInIsolatedElectron } from '../src/main/runtime/electron-backup-validation-worker';
import { WindowsBackupKeyProtector } from '../src/main/runtime/windows-backup-key-protector';
import { observeWindowsParentExit, type ObservedParentExit } from '../src/main/runtime/windows-parent-exit-observer';
import { assertAgentControlSchema } from '../../runtime/src/adapters/persistence/agentControlDbSchema.js';
import { acquireSqliteOwnerLease, closeOwnedSqliteDatabase } from '../../runtime/src/adapters/persistence/SqliteOwnerLease.js';
import { RUNTIME_DATABASE_PATHS } from '@ariadne/protocol/host';

const bundle = process.env.ARIADNE_BACKUP_NATIVE_BUNDLE, packagedApp = process.env.ARIADNE_BACKUP_PACKAGED_APP;
const workspaceId = process.env.ARIADNE_BACKUP_NATIVE_WORKSPACE_ID, workspaceRoot = process.env.ARIADNE_BACKUP_NATIVE_WORKSPACE_ROOT;
const lifecycle = process.env.ARIADNE_BACKUP_NATIVE_APPLICATION_LIFECYCLE === '1';
it.skipIf(!bundle || !packagedApp || !workspaceId || !workspaceRoot)('cold-starts original packaged Application and authorized Renderer history on authenticated restored files', async () => {
  if (![bundle!, packagedApp!, workspaceRoot!].every(isAbsolute)) throw new Error('native_cold_start_paths_invalid');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'AriadneRecoveryColdStart-'))), profile = join(root, 'profile');
  const output = join(root, 'evidence'); await mkdir(profile);
  let stage: string | undefined, comparisonStage: string | undefined, passed = false, relaunchedObserver: ObservedParentExit | undefined;
  const diagnosticCodes = new Set<string>();
  try {
    const unpacked = await unpackBackupBundle({ directory: bundle!, stagingParent: root, forbiddenRoots: [], protector: new WindowsBackupKeyProtector() });
    stage = unpacked.stage;
    const accepted = await validateBackupInIsolatedElectron({ electronExecutable: resolve('..', 'node_modules/electron/dist/electron.exe'),
      appPath: resolve('.'), packaged: false, restoreRoot: stage, stagingParent: root,
      runtimeEntry: resolve('..', 'runtime/dist/entry/storage-maintenance-process.js'), runtimeExecutable: process.execPath });
    const operationId = randomUUID(), candidate = await buildVerifiedRestoreCandidate({ unpacked, validation: accepted, dataRoot: profile, operationId });
    await prepareDataRootSwitch({ dataRoot: profile, operationId, backupId: unpacked.manifest.backupId, inventorySha256: candidate.inventorySha256 });
    // Initial profile composition is an offline journal fixture. Actual full
    // ApplicationController startup/IPC/Renderer then uses these verified bytes.
    await settleDataRootSwitch(profile, 'replacement'); await archiveSettledDataRootSwitch(profile);
    const workspaceBefore = await readdir(workspaceRoot!);
    const nativeDeadline = Date.now() + 90_000;
    const restartedExit = lifecycle ? (async () => {
      // Observe relaunch independently of the first Main's inherited stream
      // closure. Both belong to this gate's same original deadline.
      while (Date.now() < nativeDeadline) {
        try { await readFile(join(output, 'data-recovery-cold-start.json')); break; }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const restarted = JSON.parse(await readFile(join(output, 'data-recovery-cold-start.json'), 'utf8'));
      expect(restarted).toMatchObject({ passed: true, observations: { originalApplicationRestoreCommitRelaunched: true,
        preferenceMutationReplacedByBackup: true, terminalRunVersionUnchanged: true } });
      // One native observer opens a handle and checks its executable while
      // that same process is retained; no delayed CIM/PID lookup is needed.
      relaunchedObserver = await observeWindowsParentExit(restarted.mainPid, undefined, { expectedExecutable: await realpath(packagedApp!) });
      await writeFile(join(output, 'observe-relaunched-main.ack'), String(restarted.mainPid));
      const code = await relaunchedObserver.exited;
      expect(code).toBe(0); await relaunchedObserver.release(); relaunchedObserver = undefined;
      return code;
    })() : undefined;
    void restartedExit?.catch(() => undefined);
    const exit = await new Promise<number | null>((yes, no) => {
      const child = spawn(packagedApp!, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
        ELECTRON_RUN_AS_NODE: undefined, ARIADNE_SMOKE_TEST: '1', ARIADNE_SMOKE_USER_DATA: profile,
        ARIADNE_SMOKE_WORKSPACE_ID: workspaceId!, ARIADNE_SMOKE_WORKSPACE_ROOT: workspaceRoot!,
        ARIADNE_SMOKE_TEST_OUTPUT: output, ARIADNE_SMOKE_DATA_RECOVERY: '1',
        ARIADNE_SMOKE_DATA_RECOVERY_LIFECYCLE: lifecycle ? 'create-backup' : undefined } });
      let timedOut = false;
      const diagnose = (chunk: Buffer) => {
        for (const code of chunk.toString('utf8').match(/\b(?:data_recovery|agent|runtime|model|conversation|projection)_[a-z_]+\b/gu) ?? [])
          if (diagnosticCodes.size < 32) diagnosticCodes.add(code);
      };
      child.stdout?.on('data', diagnose); child.stderr?.on('data', diagnose);
      const timer = setTimeout(() => {
        timedOut = true;
        // This PID belongs to the live ChildProcess spawned above. Terminate
        // its test-owned tree and wait for actual close before file handling.
        if (child.pid && child.exitCode === null && child.signalCode === null)
          execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => child.kill());
      }, 90_000);
      child.once('error', error => { clearTimeout(timer); no(error); }); child.once('close', code => {
        clearTimeout(timer); if (timedOut) no(new Error('packaged_recovery_timeout')); else yes(code);
      });
    });
    const secondExit = await restartedExit;
    const evidence = JSON.parse(await readFile(join(output, 'data-recovery-cold-start.json'), 'utf8'));
    expect(evidence, 'Phase-only original packaged startup evidence').toMatchObject({ passed: true, originalPackagedApplication: true,
      physicalInteraction: false, submittedNewModelTurn: false });
    expect(exit).toBe(0); expect(await readdir(workspaceRoot!)).toEqual(workspaceBefore);
    expect(evidence.observations).toMatchObject({ productionPackagedStartup: true, protectedChatDraftRead: true,
      protectedDraftImageDecoded: true, protectedFileDraftRead: true, originalProtectedResponseProjected: true,
      originalRendererHistoryRead: true, originalRendererAttachmentMetadataRead: true, hiddenWindowThroughout: true });
    let coreComparison: unknown;
    if (lifecycle) {
      const checkpoint = JSON.parse(await readFile(join(output, 'application-restore-checkpoint.json'), 'utf8'));
      const actualBackup = await unpackBackupBundle({ directory: join(root, 'backups', 'Ariadne-backup-' + checkpoint.backup.backupId),
        stagingParent: root, forbiddenRoots: [profile], protector: new WindowsBackupKeyProtector() });
      comparisonStage = actualBackup.stage;
      // Both Runtime owners have actually exited. Original schema and SQLite
      // leases protect read-only logical rows, including encrypted artifacts.
      const before = readCoreLedger(join(comparisonStage, 'runtime')), after = readCoreLedger(join(profile, 'runtime'));
      expect(after).toEqual(before);
      expect(before.terminal).toMatchObject({ run_id: 'run-native', version: checkpoint.terminalRunVersion, state_status: 'completed' });
      expect(before.commands).toBeGreaterThan(0); expect(before.artifacts).toBeGreaterThan(0);
      coreComparison = { originalOwnerSchemaAndLease: true, allCoreTableRowsUnchanged: true, terminalVersion: before.terminal?.version,
        commands: before.commands, protectedArtifacts: before.artifacts, effects: before.effects,
        fixtureScope: 'terminal synthetic inference; no live external tool/network invocation' };
    }
    const externalEvidence = process.env.ARIADNE_BACKUP_PACKAGED_EVIDENCE;
    if (externalEvidence) {
      if (!isAbsolute(externalEvidence)) throw new Error('native_evidence_path_invalid');
      const checkpoint = lifecycle ? JSON.parse(await readFile(join(output, 'application-restore-checkpoint.json'), 'utf8')) : undefined;
      await writeFile(externalEvidence, JSON.stringify({ ...evidence, originalMainCleanExit: exit === 0,
        ...(lifecycle ? { applicationLifecycle: checkpoint, relaunchedMainCleanExit: secondExit === 0, coreComparison } : {}),
        authenticatedFiles: unpacked.manifest.files.length, workspaceNamesUnchanged: true,
        initialProfileComposition: 'offline verified-candidate/journal fixture, not Application restore commit',
        originalApplicationRestoreCommit: lifecycle ? 'actual original IPC/Main owners/detached helper/relaunch' : 'pending',
        providerOrShellEffects: lifecycle ? 'all original Core rows/receipts/artifacts unchanged; terminal synthetic inference scope' : 'private Core/effect comparison pending' }, null, 2));
    }
    passed = true;
  } finally {
    await relaunchedObserver?.release();
    if (comparisonStage) await removeOwnedBackupStage(root, comparisonStage, basename(comparisonStage));
    if (stage) await removeOwnedBackupStage(root, stage, basename(stage));
    if (dirname(root) !== await realpath(tmpdir()) || !basename(root).startsWith('AriadneRecoveryColdStart-') || await realpath(root) !== root)
      throw new Error('Unsafe cold-start fixture cleanup.');
    if (passed) await rm(root, { recursive: true, force: true });
    else {
      // Preserve a failed profile and its original primary failure evidence;
      // a locked browser child must not be hidden by recursive cleanup errors.
      const externalEvidence = process.env.ARIADNE_BACKUP_PACKAGED_EVIDENCE;
      if (externalEvidence && isAbsolute(externalEvidence)) {
        let observations: unknown = null;
        try { observations = JSON.parse(await readFile(join(output, 'data-recovery-cold-start.json'), 'utf8')); } catch {}
        await writeFile(externalEvidence, JSON.stringify({ passed: false, root, diagnosticCodes: [...diagnosticCodes], observations,
          failedProfileRetained: true, physicalInteraction: false }, null, 2));
      }
    }
  }
}, 120_000);

/** Test evidence only: no application owner or raw record is exported. */
function readCoreLedger(runtimeRoot: string) {
  const file = join(runtimeRoot, RUNTIME_DATABASE_PATHS.agentControl), lease = acquireSqliteOwnerLease(file, 'native-recovery-evidence');
  let database: DatabaseSync;
  try { database = new DatabaseSync(file, { readOnly: true }); } catch (error) { lease.close(); throw error; }
  try {
    assertAgentControlSchema(database);
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'agent_*' ORDER BY name").all();
    const digests = tables.map(({ name }) => {
      if (typeof name !== 'string' || !/^agent_[a-z_]+$/u.test(name)) throw new Error('native_core_table_invalid');
      const hash = createHash('sha256'); let rows = 0;
      for (const row of database.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').iterate()) {
        const value = JSON.stringify(row); hash.update(String(Buffer.byteLength(value))).update(':').update(value); rows++;
      }
      return { table: name, rows, sha256: hash.digest('hex') };
    });
    const count = (name: string) => digests.find(row => row.table === name)?.rows ?? 0;
    return { digests, commands: count('agent_commands'), effects: count('agent_effect_payloads'),
      artifacts: count('agent_checkpoints') + count('agent_turn_inputs') + count('agent_directive_payloads'),
      terminal: database.prepare("SELECT run_id,version,state_status FROM agent_runs WHERE run_id='run-native'").get() };
  } finally { closeOwnedSqliteDatabase(database, lease); }
}

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PERSONAL_ASSISTANT_WORKSPACE_ID } from '@ariadne/protocol/public';
import {
  createDefaultAssistantChatProfile,
  createDefaultRuntimePolicySnapshot
} from '@ariadne/protocol/settings';

import { RuntimeSupervisor, type RuntimeSupervisorOptions } from '../src/main/runtime/runtime-supervisor';
import { captureRuntimeSnapshotWithWorker, validateRuntimeLayoutWithWorker, validateRuntimeRecoveryWithWorker,
  inspectRuntimeAttachmentCleanupWithWorker, executeRuntimeAttachmentCleanupWithWorker } from '../src/main/runtime/runtime-storage-maintenance-worker';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { DataBackupService } from '../src/main/data-management/data-backup-service';
import { MainMaintenanceGate } from '../src/main/data-management/main-maintenance-gate';
import { StateRepository } from '../src/main/persistence/state-repository';
import { TaskNotificationReceipts } from '../src/main/persistence/task-notification-receipts';
import { WindowsBackupKeyProtector } from '../src/main/runtime/windows-backup-key-protector';
import { unpackBackupBundle } from '../src/main/data-management/backup-bundle';

const temporaryRoots: string[] = [];
const supervisors: RuntimeSupervisor[] = [];

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.stop('user_request')));
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('RuntimeSupervisor', () => {
  it('retains durable claim evidence and every original database after killing the actual storage worker mid-cleanup', async () => {
    const entry = path.resolve(process.cwd(), '..', 'runtime', 'dist', 'entry', 'runtime-process.js');
    const options = createSupervisorOptions(entry, process.env, []), supervisor = new RuntimeSupervisor(options); supervisors.push(supervisor);
    await supervisor.start();
    const worker = { entry: path.join(path.dirname(entry), 'storage-maintenance-process.js'), executablePath: process.execPath, dataRoot: options.dataRoot };
    const keyId = 'agent-key-' + randomUUID(), keys = { schemaVersion: 1 as const, generation: 1, activeKeyId: keyId,
      keys: [{ keyId, keyMaterialBase64: randomBytes(32).toString('base64') }] };
    let receiptPath = '', originalReceipt = Buffer.alloc(0), survivors: string[] = [];
    const objects = path.join(options.dataRoot, 'data/conversation/attachments/v1/objects/aa');
    await supervisor.withOfflineMaintenance(async () => {
      await mkdir(objects, { recursive: true });
      const names = Array.from({ length: 200 }, () => 'aa' + '0'.repeat(62) + '.' + randomUUID() + '.tmp');
      await Promise.all(names.map(name => writeFile(path.join(objects, name), 'Synthetic unpublished bytes')));
      const databases = Object.values((await import('@ariadne/protocol/host')).RUNTIME_DATABASE_PATHS);
      const before = await Promise.all(databases.map(file => readFile(path.join(options.dataRoot, file))));
      const preview = await inspectRuntimeAttachmentCleanupWithWorker(worker, keys), requestId = randomUUID();
      expect(preview.unpublishedObjects).toBe(200);
      const child = spawn(process.execPath, [worker.entry], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const closed = new Promise<void>((yes, no) => { child.once('error', no); child.once('close', () => yes()); });
      let response = false; child.on('message', () => { response = true; });
      child.send({ protocol: 'ariadne_storage_maintenance.v1', requestId, operation: 'execute-attachment-cleanup', dataRoot: options.dataRoot,
        keyRing: { ...keys, runtimeInstanceId: requestId }, expectedVersion: preview.version, selected: ['unpublished-attachment'] });
      const receipts = path.join(options.dataRoot, 'data/conversation/attachments/v1/cleanup-receipts');
      try {
        const deadline = Date.now() + 6_000;
        while (Date.now() < deadline) {
          try {
            const scopes = await readdir(receipts);
            if (scopes.length) {
              const candidate = path.join(receipts, scopes[0]!, 'receipt.jsonl'), bytes = await readFile(candidate, 'utf8');
              if (bytes.includes('"type":"claim-pending"')) { receiptPath = candidate; break; }
            }
          } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
          await new Promise(resolve => setTimeout(resolve, 2));
        }
        expect(receiptPath).not.toBe(''); expect(child.exitCode).toBeNull(); expect(response).toBe(false);
        child.kill(); await closed;
      } finally { if (child.exitCode === null && child.signalCode === null) { child.kill(); await closed; } }
      originalReceipt = await readFile(receiptPath);
      const completeLines = originalReceipt.toString('utf8').split('\n').slice(0, -1).map(line => JSON.parse(line));
      expect(completeLines[0]).toMatchObject({ plannedFiles: 200, planVersion: preview.version });
      expect(completeLines.some(row => row.type === 'completed')).toBe(false);
      for (const pending of completeLines.filter(row => row.type === 'claim-pending')) {
        const source = path.join(options.dataRoot, pending.entry.path), claimed = path.join(path.dirname(receiptPath), pending.ordinal + '-' + pending.entry.sha256 + '.object');
        const present = await Promise.all([source, claimed].map(async file => {
          try { expect(await readFile(file, 'utf8')).toBe('Synthetic unpublished bytes'); return true; }
          catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error; }
        }));
        if (!present.some(Boolean)) expect(completeLines.some(row => row.type === 'claim-verified' && row.ordinal === pending.ordinal)).toBe(true);
      }
      survivors = await readdir(objects); expect(survivors.length).toBeGreaterThan(0); expect(survivors.length).toBeLessThanOrEqual(200);
      const after = await inspectRuntimeAttachmentCleanupWithWorker(worker, keys);
      expect(after.unpublishedObjects).toBe(survivors.length); expect(await readFile(receiptPath)).toEqual(originalReceipt);
      expect(await Promise.all(databases.map(file => readFile(path.join(options.dataRoot, file))))).toEqual(before);
    });
    expect(supervisor.getStatus().availability).toBe('ready');
    expect(await readdir(objects)).toEqual(survivors); expect(await readFile(receiptPath)).toEqual(originalReceipt);
  }, 30_000);
  it('holds all original offline owners during attachment cleanup and rejects stale previews without changing databases', async () => {
    const entry = path.resolve(process.cwd(), '..', 'runtime', 'dist', 'entry', 'runtime-process.js');
    const options = createSupervisorOptions(entry, process.env, []), supervisor = new RuntimeSupervisor(options); supervisors.push(supervisor);
    await supervisor.start();
    const worker = { entry: path.join(path.dirname(entry), 'storage-maintenance-process.js'), executablePath: process.execPath, dataRoot: options.dataRoot };
    const keyId = 'agent-key-' + randomUUID(), keys = { schemaVersion: 1 as const, generation: 1, activeKeyId: keyId,
      keys: [{ keyId, keyMaterialBase64: randomBytes(32).toString('base64') }] };
    await expect(inspectRuntimeAttachmentCleanupWithWorker(worker, keys)).rejects.toThrow('offline_cleanup_failed');
    await supervisor.withOfflineMaintenance(async () => {
      // Fresh original owners are empty and have no installed protected key
      // anchor. This proves seven-owner worker admission, not populated recovery.
      const image = await (await import('sharp')).default({ create: { width: 2, height: 2, channels: 4, background: '#334488' } }).png().toBuffer();
      const hash = (await import('node:crypto')).createHash('sha256').update(image).digest('hex');
      const objects = path.join(options.dataRoot, 'data/conversation/attachments/v1/objects', hash.slice(0, 2)); await mkdir(objects, { recursive: true });
      const orphan = path.join(objects, hash), temporary = orphan + '.' + randomUUID() + '.tmp';
      await writeFile(orphan, image); await writeFile(temporary, 'partial');
      const databaseFiles = Object.values((await import('@ariadne/protocol/host')).RUNTIME_DATABASE_PATHS);
      const before = await Promise.all(databaseFiles.map(file => readFile(path.join(options.dataRoot, file))));
      const preview = await inspectRuntimeAttachmentCleanupWithWorker(worker, keys);
      expect(preview).toMatchObject({ referencedObjects: 0, orphanObjects: 1, unpublishedObjects: 1 });
      expect('entries' in preview).toBe(false);
      await writeFile(temporary, 'changed');
      await expect(executeRuntimeAttachmentCleanupWithWorker(worker, keys, preview.version, ['orphan-attachment'])).rejects.toThrow('attachment_cleanup_preview_changed');
      expect(await readFile(orphan)).toEqual(image);
      const current = await inspectRuntimeAttachmentCleanupWithWorker(worker, keys);
      await expect(executeRuntimeAttachmentCleanupWithWorker(worker, keys, current.version, ['orphan-attachment', 'unpublished-attachment']))
        .resolves.toMatchObject({ status: 'completed', filesDeleted: 2, bytesDeleted: image.length + 7, filesRetained: 0 });
      expect(await readdir(objects)).toEqual([]);
      expect(await Promise.all(databaseFiles.map(file => readFile(path.join(options.dataRoot, file))))).toEqual(before);
    });
    expect(supervisor.getStatus().availability).toBe('ready');
  }, 30_000);
  it('coordinates original Runtime and Main SQLite snapshots, encrypts after resume and cleans only its private stage', async () => {
    const entry = path.resolve(process.cwd(), '..', 'runtime', 'dist', 'entry', 'runtime-process.js');
    const options = createSupervisorOptions(entry, process.env, []), supervisor = new RuntimeSupervisor(options); supervisors.push(supervisor);
    const ready = await supervisor.start(), root = options.workspaces[0]!.rootPath;
    const userData = path.join(root, 'user'), sessionData = path.join(root, 'session'), stagingParent = path.join(root, 'staging'), parent = path.join(root, 'backups');
    for (const directory of [userData, sessionData, stagingParent, parent]) await mkdir(directory);
    // These two opaque files validate byte preservation, not protected-payload
    // decryption. Full Electron key/schema recovery is a separate acceptance gate.
    await writeFile(path.join(userData, 'agent-persistence-keyring.json'), 'protected-key-ring-fixture');
    await writeFile(path.join(sessionData, 'Local State'), 'profile-key-fixture');
    const gate = new MainMaintenanceGate(), state = new StateRepository(path.join(userData, 'state.json'), gate);
    await state.initialize(); await state.savePreferences({ ...state.getPreferences(), theme: 'dark' });
    const receipts = new TaskNotificationReceipts(path.join(userData, 'notification-delivery.db'), undefined, gate); await receipts.initialize();
    receipts.configure({ completed: true, failed: false });
    const ref = { runId: 'run-fixture', workspaceId: 'workspace-main', sessionId: 'session-main', version: 8, state: 'completed' as const, sourceStatus: 'completed' };
    receipts.shown(ref); const trace: string[] = [];
    const service = new DataBackupService({ userData, sessionData, stagingParent, appVersion: 'test', gate, runtime: supervisor,
      runtimeWorker: { entry: path.join(path.dirname(entry), 'storage-maintenance-process.js'), executablePath: process.execPath, dataRoot: options.dataRoot },
      taskNotificationReceipts: receipts, protector: new WindowsBackupKeyProtector(),
      prepareRendererDrafts: async () => { trace.push('renderer_prepared_fixture'); },
      resumeRendererDrafts: async () => { trace.push('renderer_resumed_fixture'); },
      pauseNotifications: async () => { trace.push('notification_paused_fixture'); },
      resumeNotifications: async () => { trace.push('notification_resumed_fixture'); },
      beforeFreeze: async () => { trace.push('before_freeze'); },
      stopMainRuntimeProducers: async () => {
        expect(supervisor.getStatus().availability).toBe('stopped');
        await expect(state.savePreferences({ ...state.getPreferences(), theme: 'light' })).rejects.toThrow('main_data_maintenance');
        expect(() => receipts.shown({ ...ref, version: 9 })).toThrow('main_data_maintenance'); trace.push('original_owners_frozen');
      }, flushMainOwners: () => state.flush() });
    try {
      const result = await service.create(parent);
      await service.waitForIdle();
      expect(result.files).toBe(11); expect(service.busy).toBe(false); expect(gate.busy).toBe(false);
      expect((await supervisor.start()).runtimeInstanceId).not.toBe(ready.runtimeInstanceId);
      expect(trace).toEqual(['renderer_prepared_fixture', 'notification_paused_fixture', 'before_freeze', 'original_owners_frozen',
        'notification_resumed_fixture', 'renderer_resumed_fixture']);
      expect(await readdir(stagingParent)).toEqual([]);
      const restored = await unpackBackupBundle({ directory: result.directory, stagingParent,
        forbiddenRoots: [userData, sessionData, options.dataRoot], protector: new WindowsBackupKeyProtector() });
      const validationOptions = { entry: path.join(path.dirname(entry), 'storage-maintenance-process.js'),
        executablePath: process.execPath, dataRoot: restored.roots.runtime };
      const beforeValidation = await Promise.all(restored.manifest.files.filter(file => file.scope === 'runtime')
        .map(file => readFile(path.join(restored.roots.runtime, file.path))));
      await expect(validateRuntimeLayoutWithWorker(validationOptions)).resolves.toEqual({ validation: 'current-layout',
        storageSchemas: { agentControl: 8, conversation: 4, publicProjection: 4, runtimeCommand: 1, productivity: 3, modelCapability: 1, longMemory: 1 } });
      const afterValidation = await Promise.all(restored.manifest.files.filter(file => file.scope === 'runtime')
        .map(file => readFile(path.join(restored.roots.runtime, file.path))));
      expect(afterValidation).toEqual(beforeValidation);
      // Empty original stores have no protected artifacts or installed key
      // anchor. This exercises the private operation, not populated recovery.
      const keyId = 'agent-key-' + randomUUID();
      await expect(validateRuntimeRecoveryWithWorker(validationOptions, { schemaVersion: 1, generation: 1,
        activeKeyId: keyId, keys: [{ keyId, keyMaterialBase64: randomBytes(32).toString('base64') }] }))
        .resolves.toMatchObject({ validation: 'current-recovery', protectedArtifacts: 0 });
      expect(await Promise.all(restored.manifest.files.filter(file => file.scope === 'runtime')
        .map(file => readFile(path.join(restored.roots.runtime, file.path))))).toEqual(beforeValidation);
      await expect(validateRuntimeLayoutWithWorker({ ...validationOptions, dataRoot: options.dataRoot })).rejects.toThrow('backup_worker_validation_failed');
      const stale = new DatabaseSync(path.join(restored.roots.runtime, 'data/agent-control/agent-control.db'));
      try { stale.exec('PRAGMA user_version=7'); } finally { stale.close(); }
      await expect(validateRuntimeLayoutWithWorker(validationOptions)).rejects.toThrow('backup_worker_validation_failed');
      const retained = new DatabaseSync(path.join(restored.roots.runtime, 'data/agent-control/agent-control.db'), { readOnly: true });
      try { expect(retained.prepare('PRAGMA user_version').get()?.user_version).toBe(7); } finally { retained.close(); }
      expect(supervisor.getStatus().availability).toBe('ready');
      expect(restored.manifest.boundary.runtimeInstanceId).toBe(ready.runtimeInstanceId);
      expect(restored.manifest.files.filter(file => file.kind === 'database')).toHaveLength(8);
      expect(JSON.parse(await readFile(path.join(restored.roots.userData, 'state.json'), 'utf8')).preferences.theme).toBe('dark');
      const restoredReceipts = new TaskNotificationReceipts(path.join(restored.roots.userData, 'notification-delivery.db'));
      await restoredReceipts.initialize(); try { expect(restoredReceipts.eligible(ref)).toBe(false); } finally { restoredReceipts.close(); }
      const sourceBytes = await readFile(path.join(userData, 'state.json'));
      // Required profile key missing: fail before publication, resume both
      // original owners and retain the remaining source files.
      const originalProfile = await readFile(path.join(sessionData, 'Local State'));
      await import('node:fs/promises').then(fs => fs.unlink(path.join(sessionData, 'Local State')));
      const previousTraceLength = trace.length;
      await expect(service.create(parent)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(supervisor.getStatus().availability).toBe('ready'); expect(gate.busy).toBe(false); expect(service.busy).toBe(false);
      expect(await readFile(path.join(userData, 'state.json'))).toEqual(sourceBytes);
      expect((await readdir(stagingParent)).filter(name => name.startsWith('.ariadne-backup-'))).toEqual([]);
      expect((await readdir(parent)).length).toBe(1); expect(trace.slice(previousTraceLength).at(-1)).toBe('renderer_resumed_fixture');
      await writeFile(path.join(sessionData, 'Local State'), originalProfile);
    } finally { receipts.close(); }
  }, 60_000);

  it('hands the real current SQLite owners to the private snapshot worker only after shutdown and waits for its process exit', async () => {
    const entry = path.resolve(process.cwd(), '..', 'runtime', 'dist', 'entry', 'runtime-process.js');
    const options = createSupervisorOptions(entry, process.env, []), supervisor = new RuntimeSupervisor(options); supervisors.push(supervisor);
    await supervisor.start();
    const worker = { entry: path.join(path.dirname(entry), 'storage-maintenance-process.js'), executablePath: process.execPath,
      dataRoot: options.dataRoot, snapshotRoot: path.join(options.workspaces[0]!.rootPath, 'denied-live-snapshot') };
    await expect(captureRuntimeSnapshotWithWorker(worker)).rejects.toThrow('backup_worker_snapshot_failed');
    expect(supervisor.getStatus().availability).toBe('ready');
    await supervisor.withOfflineMaintenance(async boundary => {
      expect(boundary.shutdownAcknowledged).toBe(true);
      const captured = await captureRuntimeSnapshotWithWorker({ ...worker, snapshotRoot: path.join(options.workspaces[0]!.rootPath, 'accepted-offline-snapshot') });
      expect(captured.files).toHaveLength(7);
      expect(captured.files.every(file => file.sqlite !== null && /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
      expect(captured.files.some(file => file.path.includes('model-capability'))).toBe(true);
      expect(captured.files.some(file => file.path.includes('long-memory'))).toBe(true);
    });
    await expect(supervisor.request({ kind: 'runtime.status.get' })).resolves.toMatchObject({ kind: 'runtime.status' });
  }, 30_000);

  it('freezes admission only after the original Runtime acknowledges a clean offline boundary, then resumes', async () => {
    const supervisor = createSupervisor(path.resolve(process.cwd(), '..', 'runtime', 'dist', 'entry', 'runtime-process.js'));
    const ready = await supervisor.start();
    await supervisor.withOfflineMaintenance(async boundary => {
      expect(boundary).toMatchObject({ runtimeInstanceId: ready.runtimeInstanceId,
        storageSchemas: ready.storageSchemas, shutdownAcknowledged: true });
      expect(supervisor.getStatus().availability).toBe('stopped');
      await expect(supervisor.start()).rejects.toMatchObject({ code: 'runtime_maintenance' });
      await expect(supervisor.request({ kind: 'runtime.status.get' })).rejects.toMatchObject({ code: 'runtime_maintenance' });
      await expect(supervisor.withOfflineMaintenance(async () => undefined)).rejects.toMatchObject({ code: 'runtime_maintenance' });
    });
    expect(supervisor.getStatus().availability).toBe('ready');
    expect((await supervisor.start()).runtimeInstanceId).not.toBe(ready.runtimeInstanceId);
    await expect(supervisor.request({ kind: 'runtime.status.get' })).resolves.toMatchObject({ kind: 'runtime.status' });
  }, 30_000);

  it('does not expose files on an unacknowledged child exit and resumes the original source', async () => {
    const supervisor = createSupervisor(path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs'),
      { ...process.env, ARIADNE_TEST_RUNTIME_BEHAVIOR: 'shutdown_without_ack' }, []);
    await supervisor.start();
    const copy = vi.fn(async () => undefined);
    await expect(supervisor.withOfflineMaintenance(copy)).rejects.toMatchObject({ code: 'runtime_maintenance_shutdown_unconfirmed' });
    expect(copy).not.toHaveBeenCalled();
    expect(supervisor.getStatus().availability).toBe('ready');
  }, 15_000);

  it('keeps the real owner closed after acknowledged final restore shutdown', async () => {
    const supervisor = createSupervisor(path.resolve(process.cwd(), '..', 'runtime', 'dist', 'entry', 'runtime-process.js'));
    await supervisor.start(); await supervisor.shutdownForDataRootSwitch();
    expect(supervisor.getStatus().availability).toBe('stopped');
    await expect(supervisor.start()).rejects.toMatchObject({ code: 'runtime_maintenance' });
    await expect(supervisor.request({ kind: 'runtime.status.get' })).rejects.toMatchObject({ code: 'runtime_maintenance' });
  }, 30_000);

  it('rejects an unacknowledged final restore shutdown and resumes the source', async () => {
    const supervisor = createSupervisor(path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs'),
      { ...process.env, ARIADNE_TEST_RUNTIME_BEHAVIOR: 'shutdown_without_ack' }, []);
    await supervisor.start();
    await expect(supervisor.shutdownForDataRootSwitch()).rejects.toMatchObject({ code: 'runtime_maintenance_shutdown_unconfirmed' });
    expect(supervisor.getStatus().availability).toBe('ready');
  }, 15_000);

  it('restores admission and the Runtime when the offline operation fails, without replaying that operation', async () => {
    const supervisor = createSupervisor(path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs'));
    await supervisor.start();
    const operation = vi.fn(async () => { throw new Error('backup_destination_full'); });
    await expect(supervisor.withOfflineMaintenance(operation)).rejects.toThrow('backup_destination_full');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(supervisor.getStatus().availability).toBe('ready');
    await expect(supervisor.request({ kind: 'runtime.status.get' })).resolves.toMatchObject({ kind: 'runtime.status' });
  }, 15_000);

  it('retains body-free startup failure health after the unready child exits, with no health-read restart', async () => {
    const options = createSupervisorOptions(path.resolve(process.cwd(), 'tests/fixtures/runtime-fixture.cjs'),
      { ...process.env, ARIADNE_TEST_RUNTIME_BEHAVIOR: 'startup_health_failure' }, []);
    const supervisor = new RuntimeSupervisor(options); supervisors.push(supervisor);
    await expect(supervisor.start()).rejects.toMatchObject({ code: 'runtime_initialization_failed' });
    await vi.waitFor(() => expect(supervisor.getStatus().availability).toBe('disabled'));
    const start = vi.spyOn(supervisor, 'start');
    expect(await supervisor.request({ kind: 'runtime.health.get' })).toMatchObject({ kind: 'runtime.health', health: {
      domains: [{ domain: 'journal', availability: 'unavailable' }]
    } }); expect(start).not.toHaveBeenCalled();
    await expect(supervisor.request({ kind: 'runtime.status.get' })).rejects.toMatchObject({ code: 'runtime_startup_source_unavailable', retryable: false });
    expect(start).not.toHaveBeenCalled();
    await supervisor.stop('user_request');
    await expect(supervisor.request({ kind: 'runtime.health.get' })).rejects.toMatchObject({ code: 'runtime_health_unavailable' });
  });
  it('starts Runtime with the App-owned personal-assistant session root', async () => {
    const options = createSupervisorOptions(
      path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs'),
      process.env,
      []
    );
    options.workspaces = [{
      workspaceId: PERSONAL_ASSISTANT_WORKSPACE_ID,
      label: '个人助手',
      rootPath: options.dataRoot,
      access: 'read'
    }];
    const supervisor = new RuntimeSupervisor(options);
    supervisors.push(supervisor);

    expect(supervisor.getStatus().availability).toBe('stopped');
    await expect(supervisor.start()).resolves.toMatchObject({ type: 'ready' });
    expect(supervisor.getStatus().availability).toBe('ready');
  }, 15_000);

  it('owns the real Runtime child and exposes only public command results', async () => {
    const supervisor = createSupervisor(
      path.resolve(process.cwd(), '..', 'runtime', 'dist', 'entry', 'runtime-process.js')
    );
    const statuses: string[] = [];
    supervisor.onStatus((status) => statuses.push(status.availability));

    await supervisor.start();
    const snapshot = await supervisor.request({
      kind: 'projection.snapshot.get',
      contractVersion: '5.0'
    });
    expect(snapshot).toMatchObject({ kind: 'projection.snapshot' });
    expect(supervisor.getStatus()).toMatchObject({
      availability: 'ready',
      protocolVersion: '3.0'
    });
    expect(statuses).toContain('starting');
    expect(statuses).toContain('ready');
  }, 30_000);

  it('brokers private Runtime capability requests through Main before readiness', async () => {
    const runtimeEntry = path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs');
    const options = createSupervisorOptions(runtimeEntry, {
      ...process.env,
      ARIADNE_TEST_RUNTIME_BEHAVIOR: 'capability_on_bootstrap'
    }, []);
    const requests: string[] = [];
    options.capabilityHandler = async (request) => {
      requests.push(request.operation.kind);
      return { available: true };
    };
    const supervisor = new RuntimeSupervisor(options);
    supervisors.push(supervisor);

    await expect(supervisor.start()).resolves.toMatchObject({ type: 'ready' });
    expect(requests).toEqual(['browser.health']);
  }, 15_000);

  it('rejects in-flight work and restarts after an unexpected child exit', async () => {
    const environment = {
      ...process.env,
      ARIADNE_TEST_RUNTIME_BEHAVIOR: 'crash_on_request'
    };
    const supervisor = createSupervisor(
      path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs'),
      environment,
      [10]
    );
    const statuses: string[] = [];
    const readyEvents: string[] = [];
    supervisor.onEvent(event => readyEvents.push(event.eventId));
    supervisor.onStatus((status) => statuses.push(status.availability));
    await supervisor.start();
    await waitUntil(() => readyEvents.length === 1);

    await expect(supervisor.request(
      { kind: 'runtime.status.get' },
      { commandId: 'command-crash' }
    )).rejects.toMatchObject({
      code: 'command_outcome_uncertain',
      retryable: false,
      correlationId: 'command-crash'
    });
    await waitUntil(() => statuses.filter((status) => status === 'ready').length === 2);

    // The restarted fixture emits cursor 1 again; the old epoch must not suppress it.
    await waitUntil(() => readyEvents.length === 2);

    expect(statuses).toContain('crashed');
    expect(statuses).toContain('restarting');
    expect(supervisor.getStatus().availability).toBe('ready');
  }, 15_000);

  it('does not send a request cancelled while the Runtime handshake is pending', async () => {
    const runtimeEntry = path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs');
    const options = createSupervisorOptions(runtimeEntry, {
      ...process.env,
      ARIADNE_TEST_RUNTIME_BEHAVIOR: 'delayed_ready_abort_gate'
    }, []);
    const supervisor = new RuntimeSupervisor(options);
    supervisors.push(supervisor);
    const controller = new AbortController();

    const result = supervisor.request(
      { kind: 'runtime.status.get' },
      {
        commandId: 'command-cancel-during-start',
        signal: controller.signal
      }
    );
    setTimeout(() => controller.abort(), 20);

    await expect(result).rejects.toMatchObject({
      code: 'runtime_request_cancelled',
      retryable: false,
      correlationId: 'command-cancel-during-start'
    });
    await expect(supervisor.request(
      { kind: 'runtime.status.get' },
      { commandId: 'command-after-start-cancel' }
    )).resolves.toMatchObject({ kind: 'runtime.status' });
  }, 15_000);

  it('uses a stable command id and sends an explicit cancel when a request deadline expires', async () => {
    const runtimeEntry = path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs');
    const options = createSupervisorOptions(runtimeEntry, {
      ...process.env,
      ARIADNE_TEST_RUNTIME_BEHAVIOR: 'cancel_gate'
    }, []);
    options.requestTimeoutMs = 30;
    const supervisor = new RuntimeSupervisor(options);
    supervisors.push(supervisor);
    await supervisor.start();

    await expect(supervisor.request(
      { kind: 'runtime.status.get' },
      { commandId: 'command-timeout' }
    )).rejects.toMatchObject({
      code: 'runtime_request_timeout',
      correlationId: 'command-timeout'
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(supervisor.request(
      { kind: 'runtime.status.get' },
      { commandId: 'command-after-cancel', timeoutMs: 1_000 }
    )).resolves.toMatchObject({ kind: 'runtime.status' });
  }, 15_000);

  it('restarts the same supervised boundary when Agent settings change', async () => {
    const runtimeEntry = path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs');
    const options = createSupervisorOptions(runtimeEntry, process.env, []);
    const supervisor = new RuntimeSupervisor(options);
    supervisors.push(supervisor);
    const statuses: string[] = [];
    supervisor.onStatus((status) => statuses.push(status.availability));
    await supervisor.start();

    await supervisor.restart({
      ...options,
      modelSelection: { modelId: '', localFallbackModelId: '' },
      modelProviders: [{
        providerId: 'openai',
        name: 'cloud-openai',
        protocol: 'openai-compatible',
        credentialEnvironmentVariable: 'OPENAI_API_KEY',
        enabled: true,
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-test',
        contextWindowTokens: 32_768,
        maxOutputTokens: 4_096,
        inference: {}
      }]
    });

    expect(statuses.filter((status) => status === 'ready')).toHaveLength(2);
    expect(statuses).toContain('stopped');
    expect(supervisor.getStatus().availability).toBe('ready');
  }, 15_000);

  it('serializes concurrent restarts and leaves the newest configuration active', async () => {
    const runtimeEntry = path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs');
    const options = createSupervisorOptions(runtimeEntry, process.env, []);
    const supervisor = new RuntimeSupervisor(options);
    supervisors.push(supervisor);
    const statuses: string[] = [];
    supervisor.onStatus((status) => statuses.push(status.availability));
    await supervisor.start();

    const first = supervisor.restart({ ...options, runtimeVersion: '0.2.0' });
    const second = supervisor.restart({ ...options, runtimeVersion: '0.3.0' });
    const [firstReady, secondReady] = await Promise.all([first, second]);

    expect(firstReady.runtimeVersion).toBe('0.2.0');
    expect(secondReady.runtimeVersion).toBe('0.3.0');
    expect(statuses.filter((status) => status === 'ready')).toHaveLength(3);
    expect(supervisor.getStatus()).toMatchObject({
      availability: 'ready',
      runtimeVersion: '0.3.0'
    });
  }, 15_000);

  it('rejects a Runtime that reports a different version', async () => {
    const supervisor = createSupervisor(
      path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs'),
      {
        ...process.env,
        ARIADNE_TEST_RUNTIME_VERSION: '9.9.9'
      },
      []
    );

    await expect(supervisor.start()).rejects.toMatchObject({
      code: 'runtime_protocol_violation'
    });
    await waitUntil(() => supervisor.getStatus().availability === 'disabled');
  }, 15_000);

  it('rejects a Runtime from a different build even when package versions match', async () => {
    const supervisor = createSupervisor(
      path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs'),
      {
        ...process.env,
        ARIADNE_TEST_RUNTIME_BUILD_FINGERPRINT: 'b'.repeat(64)
      },
      []
    );

    await expect(supervisor.start()).rejects.toMatchObject({
      code: 'runtime_protocol_violation'
    });
    await waitUntil(() => supervisor.getStatus().availability === 'disabled');
  }, 15_000);

  it('restarts a ready Runtime before the next request when its build manifest changes', async () => {
    const runtimeEntry = path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs');
    const options = createSupervisorOptions(runtimeEntry, process.env, []);
    const manifestPath = path.join(options.dataRoot, 'runtime-build.json');
    writeBuildManifest(manifestPath, 'a'.repeat(64));
    delete options.runtimeBuildFingerprint;
    options.runtimeBuildManifestPath = manifestPath;
    const supervisor = new RuntimeSupervisor(options);
    supervisors.push(supervisor);
    const readyFingerprints: string[] = [];
    supervisor.onStatus((status) => {
      if (status.availability === 'ready' && status.runtimeBuildFingerprint) {
        readyFingerprints.push(status.runtimeBuildFingerprint);
      }
    });
    await supervisor.start();

    writeBuildManifest(manifestPath, 'b'.repeat(64));
    await expect(supervisor.request({ kind: 'runtime.status.get' }))
      .resolves.toMatchObject({ kind: 'runtime.status' });

    expect(readyFingerprints).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
    expect(supervisor.getStatus().runtimeBuildFingerprint).toBe('b'.repeat(64));
  }, 15_000);

  it('preserves the Runtime ready payload for repeated start calls', async () => {
    const supervisor = createSupervisor(
      path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs')
    );

    const first = await supervisor.start();
    const second = await supervisor.start();

    expect(first.storageSchemas).toEqual({ fixture: 1 });
    expect(second).toEqual(first);
  }, 15_000);

  it('contains executable launch failures without an unhandled child error', async () => {
    const runtimeEntry = path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs');
    const options = createSupervisorOptions(runtimeEntry, process.env, []);
    options.executablePath = path.join(options.dataRoot, 'missing-runtime-node.exe');
    const supervisor = new RuntimeSupervisor(options);
    supervisors.push(supervisor);

    await expect(supervisor.start()).rejects.toBeInstanceOf(Error);
    await waitUntil(() => supervisor.getStatus().availability === 'disabled');
  }, 15_000);

  it('isolates failing observers from Runtime lifecycle and other observers', async () => {
    const supervisor = createSupervisor(
      path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs')
    );
    const observedStatuses: string[] = [];
    const observedEvents: string[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    supervisor.onStatus(() => { throw new Error('broken status observer'); });
    supervisor.onStatus((status) => observedStatuses.push(status.availability));
    supervisor.onEvent(() => { throw new Error('broken event observer'); });
    supervisor.onEvent((event) => observedEvents.push(event.event.kind));

    try {
      await supervisor.start();
      expect(supervisor.getStatus().availability).toBe('ready');
      expect(observedStatuses).toContain('ready');
      await vi.waitFor(() => {
        expect(observedEvents).toContain('projection.changed');
      });
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  }, 15_000);

  it('discards queued events from an old Runtime epoch after restart', async () => {
    const runtimeEntry = path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs');
    const supervisor = new RuntimeSupervisor(
      createSupervisorOptions(runtimeEntry, process.env, [])
    );
    supervisors.push(supervisor);
    const oldChild = {};
    const newChild = {};
    const internals = supervisor as unknown as {
      child: object | null;
      runtimeInstanceId: string | null;
      lastEventCursor: number;
      eventDeliveryQueue: Promise<void>;
      handleMessage(child: object, raw: unknown): void;
    };
    internals.child = oldChild;
    internals.runtimeInstanceId = '11111111-1111-4111-8111-111111111111';
    internals.lastEventCursor = 1;
    const observed: string[] = [];
    supervisor.onEvent((event) => observed.push(event.eventId));

    internals.handleMessage(
      oldChild,
      runtimeEventMessage('11111111-1111-4111-8111-111111111111', 3, 'old-event-3')
    );
    const oldEpochQueue = internals.eventDeliveryQueue;
    internals.child = newChild;
    internals.runtimeInstanceId = '22222222-2222-4222-8222-222222222222';
    internals.lastEventCursor = 0;
    internals.eventDeliveryQueue = Promise.resolve();
    internals.handleMessage(
      newChild,
      runtimeEventMessage('22222222-2222-4222-8222-222222222222', 1, 'new-event-1')
    );
    await internals.eventDeliveryQueue;

    await oldEpochQueue;

    expect(observed).toEqual(['new-event-1']);
    expect(internals.lastEventCursor).toBe(1);
  });

  it('resets the consecutive-crash budget after a stable ready interval', async () => {
    const runtimeEntry = path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs');
    const options = createSupervisorOptions(runtimeEntry, {
      ...process.env,
      ARIADNE_TEST_RUNTIME_BEHAVIOR: 'crash_on_request'
    }, [10]);
    options.restartStabilityMs = 30;
    const supervisor = new RuntimeSupervisor(options);
    supervisors.push(supervisor);
    const statuses: string[] = [];
    supervisor.onStatus((status) => statuses.push(status.availability));
    await supervisor.start();

    await expect(supervisor.request({ kind: 'runtime.status.get' })).rejects.toMatchObject({
      code: 'command_outcome_uncertain',
      retryable: false
    });
    await waitUntil(() => statuses.filter((status) => status === 'ready').length === 2);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await expect(supervisor.request({ kind: 'runtime.status.get' })).rejects.toMatchObject({
      code: 'command_outcome_uncertain',
      retryable: false
    });
    await waitUntil(() => statuses.filter((status) => status === 'ready').length === 3);

    expect(supervisor.getStatus().availability).toBe('ready');
    expect(statuses).not.toContain('disabled');
  }, 15_000);

  it('blocks replacement when termination does not produce a confirmed child exit', async () => {
    const runtimeEntry = path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs');
    const options = createSupervisorOptions(runtimeEntry, process.env, []);
    options.shutdownTimeoutMs = 40;
    const supervisor = new RuntimeSupervisor(options);
    const child = Object.assign(new EventEmitter(), {
      connected: true,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(() => false),
      send: vi.fn((_message: unknown, callback: (error: Error | null) => void) => callback(null))
    });
    const internals = supervisor as unknown as {
      child: typeof child | null;
      runtimeInstanceId: string | null;
      currentStatus: { availability: string };
    };
    internals.child = child;
    internals.runtimeInstanceId = '11111111-1111-4111-8111-111111111111';
    internals.currentStatus = {
      availability: 'ready',
      capabilities: [],
      observedAt: new Date().toISOString()
    } as never;

    await expect(supervisor.restart(options)).rejects.toMatchObject({
      code: 'runtime_process_exit_timeout',
      retryable: false
    });

    expect(child.kill).toHaveBeenCalled();
    expect(internals.child).toBe(child);
    expect(supervisor.getStatus()).toMatchObject({
      availability: 'crashed',
      detail: expect.stringContaining('replacement is blocked')
    });
    internals.child = null;
  });
});

function runtimeEventMessage(runtimeInstanceId: string, cursor: number, eventId: string) {
  return {
    protocol: 'ariadne_runtime',
    protocolVersion: '3.0',
    runtimeInstanceId,
    type: 'event',
    event: {
      eventId,
      cursor,
      schemaVersion: '2.0',
      aggregateType: 'projection',
      aggregateId: eventId,
      aggregateVersion: cursor,
      occurredAt: new Date().toISOString(),
      event: {
        kind: 'projection.changed', feature: 'diagnostics'
      }
    }
  } as const;
}

function createSupervisor(
  runtimeEntry: string,
  environment: NodeJS.ProcessEnv = process.env,
  restartDelaysMs: readonly number[] = []
): RuntimeSupervisor {
  const supervisor = new RuntimeSupervisor(createSupervisorOptions(runtimeEntry, environment, restartDelaysMs));
  supervisors.push(supervisor);
  return supervisor;
}

function createSupervisorOptions(
  runtimeEntry: string,
  environment: NodeJS.ProcessEnv,
  restartDelaysMs: readonly number[]
): RuntimeSupervisorOptions {
  const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'ariadne-supervisor-data-'));
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'ariadne-supervisor-workspace-'));
  temporaryRoots.push(dataRoot, workspaceRoot);
  return {
    runtimeEntry,
    ...(runtimeEntry.includes('runtime-fixture')
      ? { runtimeBuildFingerprint: 'a'.repeat(64) }
      : {
          runtimeBuildManifestPath: path.resolve(
            process.cwd(),
            '..',
            'runtime',
            'dist',
            'runtime-build.json'
          )
        }),
    installRoot: runtimeEntry.includes('runtime-fixture')
      ? path.resolve(process.cwd())
      : path.resolve(process.cwd(), '..', 'runtime'),
    dataRoot,
    modelRoots: [path.join(dataRoot, 'models')],
    modelProviders: [],
    modelSelection: { modelId: '', localFallbackModelId: '' },
    assistantProfile: createDefaultAssistantChatProfile(),
    agentPermissions: {
      approvalPolicy: 'request',
      proposalApproval: 'manual',
      permissionPolicy: 'confirmBeforeRun',
      sandboxMode: 'workspace-write',
      allowedPermissions: ['read', 'write', 'shell', 'network', 'dangerous']
    },
    agentAdmissionAuthoritySource: {
      sourceVersion: 1,
      status: 'disabled',
      reason: 'not_configured'
    },
    runtimePolicy: createDefaultRuntimePolicySnapshot(),
    workspaces: [{
      workspaceId: 'test',
      label: 'Test workspace',
      rootPath: workspaceRoot,
      access: 'write'
    }],
    profile: 'local-only',
    appVersion: 'test',
    runtimeVersion: '0.1.0',
    production: false,
    executablePath: process.execPath,
    environment,
    restartDelaysMs,
    handshakeTimeoutMs: 15_000,
    requestTimeoutMs: 5_000,
    shutdownTimeoutMs: 2_000
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition timeout');
}

function writeBuildManifest(filePath: string, fingerprint: string): void {
  writeFileSync(filePath, JSON.stringify({
    schemaVersion: 1,
    runtimeVersion: '0.1.0',
    fingerprint
  }));
}

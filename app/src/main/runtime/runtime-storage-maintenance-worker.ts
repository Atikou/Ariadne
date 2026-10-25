import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { RuntimeAgentPersistenceKeyRing } from '../persistence/agent-persistence-keyring';
import { storageMaintenanceRequestSchema, storageMaintenanceResponseSchema, assertRuntimeMessageSize,
  type StorageMaintenanceRequest, type StorageMaintenanceResponse } from '@ariadne/protocol/host';

export interface RuntimeSnapshotWorkerOptions {
  entry: string; executablePath: string; dataRoot: string; snapshotRoot: string; signal?: AbortSignal;
}
type MaintenanceResult = Extract<StorageMaintenanceResponse['outcome'], { ok: true }>['result'];
export class RuntimeStorageValidationError extends Error {
  constructor(readonly phase: 'layout' | 'key-anchor' | 'agent-payloads' | 'conversation') { super('backup_worker_validation_failed'); }
}
/** Private storage owner process; its successful message alone is insufficient.
 * Main waits for actual clean process exit before resuming the original Runtime. */
export async function captureRuntimeSnapshotWithWorker(options: RuntimeSnapshotWorkerOptions): Promise<
  Extract<MaintenanceResult, { files: unknown }>> {
  if (![options.entry, options.executablePath, options.dataRoot, options.snapshotRoot].every(isAbsolute))
    throw new Error('backup_worker_path_invalid');
  if (options.signal?.aborted) throw new Error('backup_worker_cancelled');
  const request = storageMaintenanceRequestSchema.parse({ protocol: 'ariadne_storage_maintenance.v1',
    requestId: randomUUID(), operation: 'snapshot', dataRoot: options.dataRoot, snapshotRoot: options.snapshotRoot });
  assertRuntimeMessageSize(request);
  const result = await invokeStorageWorker(options, request);
  if (!('files' in result)) throw new Error('backup_worker_response_operation_mismatch');
  return result;
}

export async function validateRuntimeLayoutWithWorker(options: Omit<RuntimeSnapshotWorkerOptions, 'snapshotRoot'>): Promise<
  Extract<MaintenanceResult, { validation: 'current-layout' }>> {
  if (![options.entry, options.executablePath, options.dataRoot].every(isAbsolute)) throw new Error('backup_worker_path_invalid');
  if (options.signal?.aborted) throw new Error('backup_worker_cancelled');
  const request = storageMaintenanceRequestSchema.parse({ protocol: 'ariadne_storage_maintenance.v1', requestId: randomUUID(),
    operation: 'validate-layout', dataRoot: options.dataRoot });
  assertRuntimeMessageSize(request);
  const result = await invokeStorageWorker(options, request);
  if (!('validation' in result) || result.validation !== 'current-layout') throw new Error('backup_worker_response_operation_mismatch');
  return result;
}

export async function validateRuntimeRecoveryWithWorker(options: Omit<RuntimeSnapshotWorkerOptions, 'snapshotRoot'>,
  keyRing: RuntimeAgentPersistenceKeyRing): Promise<Extract<MaintenanceResult, { validation: 'current-recovery' }>> {
  if (![options.entry, options.executablePath, options.dataRoot].every(isAbsolute)) throw new Error('backup_worker_path_invalid');
  if (options.signal?.aborted) throw new Error('backup_worker_cancelled');
  const requestId = randomUUID();
  const request = storageMaintenanceRequestSchema.parse({ protocol: 'ariadne_storage_maintenance.v1', requestId,
    operation: 'validate-recovery', dataRoot: options.dataRoot, keyRing: { ...keyRing, runtimeInstanceId: requestId } });
  assertRuntimeMessageSize(request);
  const result = await invokeStorageWorker(options, request);
  if (!('validation' in result) || result.validation !== 'current-recovery') throw new Error('backup_worker_response_operation_mismatch');
  return result;
}

export async function inspectRuntimeAttachmentCleanupWithWorker(options: Omit<RuntimeSnapshotWorkerOptions, 'snapshotRoot'>,
  keyRing: RuntimeAgentPersistenceKeyRing): Promise<Extract<MaintenanceResult, { maintenance: 'attachment-cleanup-preview' }>> {
  const result = await invokeAttachmentCleanupWorker(options, keyRing, { operation: 'inspect-attachment-cleanup' });
  if (!('maintenance' in result) || result.maintenance !== 'attachment-cleanup-preview') throw new Error('backup_worker_response_operation_mismatch');
  return result;
}
export async function executeRuntimeAttachmentCleanupWithWorker(options: Omit<RuntimeSnapshotWorkerOptions, 'snapshotRoot'>,
  keyRing: RuntimeAgentPersistenceKeyRing, expectedVersion: string,
  selected: readonly ('orphan-attachment' | 'unpublished-attachment')[]): Promise<Extract<MaintenanceResult, { maintenance: 'attachment-cleanup-result' }>> {
  const result = await invokeAttachmentCleanupWorker(options, keyRing, { operation: 'execute-attachment-cleanup', expectedVersion, selected: [...selected] });
  if (!('maintenance' in result) || result.maintenance !== 'attachment-cleanup-result') throw new Error('backup_worker_response_operation_mismatch');
  return result;
}
async function invokeAttachmentCleanupWorker(options: Omit<RuntimeSnapshotWorkerOptions, 'snapshotRoot'>,
  keyRing: RuntimeAgentPersistenceKeyRing, operation: { operation: 'inspect-attachment-cleanup' }
    | { operation: 'execute-attachment-cleanup'; expectedVersion: string; selected: ('orphan-attachment' | 'unpublished-attachment')[] }): Promise<MaintenanceResult> {
  if (![options.entry, options.executablePath, options.dataRoot].every(isAbsolute)) throw new Error('backup_worker_path_invalid');
  if (options.signal?.aborted) throw new Error('backup_worker_cancelled');
  const requestId = randomUUID(), request = storageMaintenanceRequestSchema.parse({ protocol: 'ariadne_storage_maintenance.v1', requestId,
    dataRoot: options.dataRoot, keyRing: { ...keyRing, runtimeInstanceId: requestId }, ...operation });
  assertRuntimeMessageSize(request);
  return invokeStorageWorker(options, request);
}

async function invokeStorageWorker(options: Omit<RuntimeSnapshotWorkerOptions, 'snapshotRoot'>,
  request: StorageMaintenanceRequest): Promise<MaintenanceResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.executablePath, [options.entry], { cwd: options.dataRoot,
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
    let response: StorageMaintenanceResponse | null = null, fault: Error | null = null;
    const fail = (code: string): void => { fault ??= new Error(code); if (child.exitCode === null && child.signalCode === null) child.kill(); };
    const cancel = (): void => fail('backup_worker_cancelled');
    const timer = setTimeout(() => fail('backup_worker_timeout'), 10 * 60_000);
    options.signal?.addEventListener('abort', cancel, { once: true });
    child.stdout?.resume(); child.stderr?.resume(); // Never forward protected diagnostics.
    child.on('error', () => fail('backup_worker_process_failed'));
    child.on('message', input => {
      try {
        assertRuntimeMessageSize(input);
        const parsed = storageMaintenanceResponseSchema.parse(input);
        if (response || parsed.requestId !== request.requestId) throw new Error('backup_worker_response_identity_changed');
        response = parsed;
      } catch { fail('backup_worker_response_invalid'); }
    });
    child.on('close', code => {
      clearTimeout(timer); options.signal?.removeEventListener('abort', cancel);
      if (fault) { reject(fault); return; }
      if (code !== 0 || !response?.outcome.ok) {
        if (response && !response.outcome.ok && request.operation.endsWith('attachment-cleanup')) {
          reject(new Error(response.outcome.code)); return;
        }
        if (response && !response.outcome.ok && response.outcome.validationPhase) {
          reject(new RuntimeStorageValidationError(response.outcome.validationPhase)); return;
        }
        reject(new Error(request.operation === 'snapshot' ? 'backup_worker_snapshot_failed' : 'backup_worker_validation_failed')); return;
      }
      resolve(response.outcome.result);
    });
    child.send(request, error => { if (error) fail('backup_worker_request_failed'); });
  });
}

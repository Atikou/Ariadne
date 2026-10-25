import { assertRuntimeMessageSize, storageMaintenanceRequestSchema, storageMaintenanceResponseSchema, type StorageMaintenanceResponse } from '@ariadne/protocol/host';
import { captureOfflineRuntimeBackup } from '../adapters/persistence/OfflineRuntimeBackupOwner.js';
import { validateOfflineRuntimeLayout, validateOfflineRuntimeRecovery, OfflineRecoveryValidationError } from '../composition/OfflineRuntimeLayoutValidation.js';
import { productionModelCapabilityStorageValidation } from '../application/ProductionModelCapabilitySource.js';
import { inspectOfflineAttachmentCleanup } from '../adapters/persistence/OfflineConversationAttachmentMaintenance.js';
import { executeOfflineAttachmentCleanup } from '../adapters/persistence/OfflineConversationAttachmentCleanup.js';
if (!process.send) throw new Error('Storage maintenance requires its owning Main IPC process.');

// Storage maintenance never bootstraps Agent, inference, tools or schedulers.
// The owning Main invokes it only inside its acknowledged offline boundary.
let handled = false;
process.on('message', async input => {
  if (handled || !process.send) { process.exitCode = 1; process.disconnect?.(); return; }
  handled = true;
  const parsed = storageMaintenanceRequestSchema.safeParse(input);
  if (!parsed.success) { process.exitCode = 1; process.disconnect?.(); return; }
  const request = parsed.data;
  let response;
  try {
    let result: unknown;
    if (request.operation === 'snapshot') result = captureOfflineRuntimeBackup(request.dataRoot, request.snapshotRoot);
    else if (request.operation === 'validate-layout') result = validateOfflineRuntimeLayout(request.dataRoot, productionModelCapabilityStorageValidation);
    else if (request.operation === 'validate-recovery') result = await validateOfflineRuntimeRecovery(request.dataRoot, productionModelCapabilityStorageValidation, request.keyRing);
    else {
      let cleanup: Extract<Extract<StorageMaintenanceResponse['outcome'], { ok: true }>['result'], { maintenance: string }> | undefined;
      await validateOfflineRuntimeRecovery(request.dataRoot, productionModelCapabilityStorageValidation, request.keyRing, async databases => {
        const conversation = databases.get('conversation')!;
        if (request.operation === 'execute-attachment-cleanup') cleanup = await executeOfflineAttachmentCleanup(request.dataRoot,
          conversation, request.expectedVersion, request.selected);
        else {
          const { entries: _entries, ...metadata } = await inspectOfflineAttachmentCleanup(request.dataRoot, conversation);
          cleanup = { maintenance: 'attachment-cleanup-preview', ...metadata };
        }
      });
      if (!cleanup) throw new Error('attachment_cleanup_result_missing');
      result = cleanup;
    }
    response = storageMaintenanceResponseSchema.parse({ protocol: request.protocol, requestId: request.requestId,
      outcome: { ok: true, result } });
    assertRuntimeMessageSize(response);
  } catch (error) {
    const cleanup = request.operation === 'inspect-attachment-cleanup' || request.operation === 'execute-attachment-cleanup';
    const code = cleanup && error instanceof Error && ['attachment_cleanup_preview_changed', 'attachment_cleanup_selection_empty'].includes(error.message)
      ? error.message : request.operation === 'snapshot' ? 'offline_snapshot_failed' : cleanup ? 'offline_cleanup_failed' : 'offline_validation_failed';
    response = storageMaintenanceResponseSchema.parse({ protocol: request.protocol, requestId: request.requestId,
      outcome: { ok: false, code,
        ...(error instanceof OfflineRecoveryValidationError ? { validationPhase: error.phase } : {}) } });
    process.exitCode = 1;
  }
  process.send(response, error => { if (error) process.exitCode = 1; process.disconnect?.(); });
});
process.on('disconnect', () => { if (!handled) process.exitCode = 1; });

import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { inspectOfflineAttachmentCleanup, inspectCleanupFile, assertOwnedCleanupPath,
  type OfflineAttachmentCleanupEntry } from './OfflineConversationAttachmentMaintenance.js';

export interface OfflineAttachmentCleanupResult {
  readonly maintenance: 'attachment-cleanup-result'; readonly operationId: string; readonly status: 'completed' | 'interrupted';
  readonly filesDeleted: number; readonly bytesDeleted: number; readonly filesRetained: number; readonly auditRecorded: true;
}

/** The caller holds the original validated owner leases for the entire call.
 * Never accepts filesystem paths from a request. Recompute the complete plan
 * version before the first mutation, then durably journal each atomic claim
 * before deleting its exact verified bytes. Interrupted/changed claims and
 * every receipt remain evidence; they are never background cleanup targets. */
export async function executeOfflineAttachmentCleanup(dataRoot: string, conversation: DatabaseSync,
  expectedVersion: string, selected: readonly OfflineAttachmentCleanupEntry['category'][]): Promise<OfflineAttachmentCleanupResult> {
  if (!/^[a-f0-9]{64}$/u.test(expectedVersion) || selected.length < 1 || selected.length > 2 || new Set(selected).size !== selected.length
    || selected.some(value => !['orphan-attachment', 'unpublished-attachment'].includes(value))) throw new Error('attachment_cleanup_request_invalid');
  const root = await realpath(dataRoot), plan = await inspectOfflineAttachmentCleanup(root, conversation);
  if (plan.version !== expectedVersion) throw new Error('attachment_cleanup_preview_changed');
  const entries = plan.entries.filter(entry => selected.includes(entry.category)), operationId = randomUUID();
  if (entries.length === 0) throw new Error('attachment_cleanup_selection_empty');
  const base = path.join(root, 'data/conversation/attachments/v1');
  await assertOwnedCleanupPath(root, base);
  const receipts = path.join(base, 'cleanup-receipts');
  try { await mkdir(receipts); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  await assertOwnedCleanupPath(root, receipts); if (!(await lstat(receipts)).isDirectory()) throw new Error('attachment_cleanup_receipt_invalid');
  const scope = path.join(receipts, operationId); await mkdir(scope); await assertOwnedCleanupPath(root, scope);
  const audit = await open(path.join(scope, 'receipt.jsonl'), 'wx', 0o600);
  const record = async (value: unknown): Promise<void> => { await audit.writeFile(JSON.stringify(value) + '\n'); await audit.sync(); };
  let filesDeleted = 0, bytesDeleted = 0, status: OfflineAttachmentCleanupResult['status'] = 'completed';
  try {
    await record({ format: 'ariadne.attachment-cleanup-receipt', version: 1, operationId, planVersion: plan.version,
      selected, plannedFiles: entries.length, plannedBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), createdAt: new Date().toISOString() });
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!, source = path.join(root, entry.path), claimed = path.join(scope, index + '-' + entry.sha256 + '.object');
      const current = await inspectCleanupFile(root, entry.path);
      if (!matches(entry, current)) throw new Error('attachment_cleanup_candidate_changed');
      await record({ type: 'claim-pending', ordinal: index, entry });
      await rename(source, claimed);
      const inspected = await inspectCleanupFile(root, path.relative(root, claimed));
      if (!matches(entry, inspected)) throw new Error('attachment_cleanup_claim_changed');
      await record({ type: 'claim-verified', ordinal: index });
      await unlink(claimed); filesDeleted++; bytesDeleted += entry.bytes;
      await record({ type: 'deleted', ordinal: index });
    }
    await record({ type: 'completed', filesDeleted, bytesDeleted });
  } catch {
    status = 'interrupted';
    // An audit write failure is not hidden: if this receipt cannot be flushed,
    // the private worker fails and the last pending durable entry stays the
    // authoritative evidence for explicit reconciliation.
    await record({ type: 'interrupted', filesDeleted, bytesDeleted, filesRetained: entries.length - filesDeleted });
  } finally { await audit.close(); }
  return { maintenance: 'attachment-cleanup-result', operationId, status, filesDeleted, bytesDeleted,
    filesRetained: entries.length - filesDeleted, auditRecorded: true };
}
function matches(entry: OfflineAttachmentCleanupEntry, current: Awaited<ReturnType<typeof inspectCleanupFile>>): boolean {
  return entry.dev === current.dev && entry.inode === current.inode && entry.modifiedAt === current.modifiedAt
    && entry.bytes === current.bytes && entry.sha256 === current.sha256;
}

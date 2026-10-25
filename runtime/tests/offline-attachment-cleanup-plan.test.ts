import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import { SqliteConversationRunHandoffUnitOfWork } from '../src/adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import { ConversationAuthorityService } from '../src/control/conversation/ConversationAuthorityService.js';
import { LocalConversationAttachmentStore } from '../src/adapters/attachment/LocalConversationAttachmentStore.js';
import { resolveConversationDatabasePath } from '../src/adapters/persistence/ConversationDbSchema.js';
import { inspectOfflineAttachmentCleanup } from '../src/adapters/persistence/OfflineConversationAttachmentMaintenance.js';
import { executeOfflineAttachmentCleanup } from '../src/adapters/persistence/OfflineConversationAttachmentCleanup.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';

const resources: { root: string; unit: SqliteConversationRunHandoffUnitOfWork; database: DatabaseSync }[] = [];
const faults = vi.hoisted(() => ({ claim: '' as '' | 'fail' | 'replace' }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, rename: async (...args: Parameters<typeof fs.rename>) => {
    const fault = faults.claim; faults.claim = '';
    if (fault === 'fail') throw Object.assign(new Error('Synthetic claim I/O failure'), { code: 'EIO' });
    await fs.rename(...args);
    if (fault === 'replace') await fs.writeFile(args[1], 'Synthetic unexpected claimed bytes');
  } };
});
const at = '2032-01-01T00:00:00.000Z';
afterEach(async () => { faults.claim = ''; for (const f of resources.splice(0)) {
  f.database.close(); const shutdown = createShutdownContext(Date.now() + 5000);
  try { await f.unit.close(shutdown); } finally { shutdown.dispose(); }
  if (dirname(f.root) !== await realpath(tmpdir()) || !basename(f.root).startsWith('AriadneCleanupPlan-') || await realpath(f.root) !== f.root)
    throw new Error('Unsafe fixture cleanup.');
  await rm(f.root, { recursive: true, force: true });
} });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'AriadneCleanupPlan-'))), unit = new SqliteConversationRunHandoffUnitOfWork(root);
  const database = new DatabaseSync(resolveConversationDatabasePath(root), { readOnly: true }); resources.push({ root, unit, database });
  const authority = new ConversationAuthorityService(unit), images = new LocalConversationAttachmentStore(root);
  await authority.createSession({ kind: 'conversation.create_session', commandId: 'cleanup-create', eventId: 'cleanup-created',
    sessionId: 'session-a', workspaceId: 'workspace-a', expectedVersion: null, occurredAt: at });
  const image = async (color: string) => {
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 4, background: color } }).png().toBuffer();
    return (await images.saveImages([{ mediaType: 'image/png', data: bytes.toString('base64') }]))[0]!;
  };
  const referenced = await image('#335588'), orphan = await image('#559977');
  const objectPath = (id: string) => { const hash = id.slice('sha256:'.length); return join(root, 'data/conversation/attachments/v1/objects', hash.slice(0, 2), hash); };
  await authority.acceptUserMessage({ kind: 'conversation.accept_user_message', commandId: 'cleanup-message', eventId: 'cleanup-message-event',
    sessionId: 'session-a', workspaceId: 'workspace-a', expectedSessionVersion: 1, messageId: 'message-a', expectedMessageVersion: null,
    content: 'Synthetic immutable image owner', attachments: [referenced], sagaId: 'saga-a', handoffCommandId: 'cleanup-handoff',
    handoffOutboxMessageId: 'cleanup-outbox', occurredAt: at });
  const temporary = objectPath(orphan.attachmentId) + '.00000000-0000-4000-8000-000000000001.tmp'; await writeFile(temporary, 'partial');
  return { root, unit, database, authority, referenced, orphan, temporary, objectPath };
}
it('retains archived immutable message references and recovery evidence while previewing only exact orphan and unpublished files', async () => {
  const f = await fixture();
  await f.authority.mutateSession({ kind: 'conversation.mutate_session', commandId: 'cleanup-archive', eventId: 'cleanup-archived',
    sessionId: 'session-a', workspaceId: 'workspace-a', expectedSessionVersion: 2, mutation: { kind: 'set_status', status: 'archived' }, occurredAt: at });
  const evidence = join(f.root, 'data/conversation/attachments/v1/cleanup-receipts'); await mkdir(evidence); await writeFile(join(evidence, 'retained.jsonl'), 'recovery evidence');
  const first = await inspectOfflineAttachmentCleanup(f.root, f.database), second = await inspectOfflineAttachmentCleanup(f.root, f.database);
  expect(first).toEqual(second); expect(first.referencedObjects).toBe(1); expect(first.orphanObjects).toBe(1); expect(first.unpublishedObjects).toBe(1);
  expect(first.orphanBytes).toBe(f.orphan.bytes); expect(first.unpublishedBytes).toBe(7);
  expect(first.entries.some(entry => entry.path.endsWith(f.referenced.attachmentId.slice(7)))).toBe(false);
  expect(await readFile(join(evidence, 'retained.jsonl'), 'utf8')).toBe('recovery evidence');
  expect(await readFile(f.objectPath(f.referenced.attachmentId))).toHaveLength(f.referenced.bytes);
});
it('changes its exact preview version when an orphan gains an immutable authority reference', async () => {
  const f = await fixture(), before = await inspectOfflineAttachmentCleanup(f.root, f.database);
  await f.authority.acceptUserMessage({ kind: 'conversation.accept_user_message', commandId: 'cleanup-message-b', eventId: 'cleanup-message-b-event',
    sessionId: 'session-a', workspaceId: 'workspace-a', expectedSessionVersion: 2, messageId: 'message-b', expectedMessageVersion: null,
    content: 'Synthetic newly referenced image', attachments: [f.orphan], sagaId: 'saga-b', handoffCommandId: 'cleanup-handoff-b',
    handoffOutboxMessageId: 'cleanup-outbox-b', occurredAt: at });
  const after = await inspectOfflineAttachmentCleanup(f.root, f.database);
  expect(after.version).not.toBe(before.version); expect(after.referencedObjects).toBe(2); expect(after.orphanObjects).toBe(0);
});
it('rejects unknown objects and digest damage and leaves every byte untouched by preview', async () => {
  const f = await fixture(), original = await readFile(f.objectPath(f.referenced.attachmentId));
  const unknown = join(dirname(f.temporary), 'unknown.txt'); await writeFile(unknown, 'unowned');
  await expect(inspectOfflineAttachmentCleanup(f.root, f.database)).rejects.toThrow('attachment_cleanup_object_invalid'); await rm(unknown);
  await writeFile(f.objectPath(f.orphan.attachmentId), 'changed orphan');
  await expect(inspectOfflineAttachmentCleanup(f.root, f.database)).rejects.toThrow('attachment_cleanup_digest_mismatch');
  expect(await readFile(f.objectPath(f.orphan.attachmentId), 'utf8')).toBe('changed orphan');
  expect(await readFile(f.objectPath(f.referenced.attachmentId))).toEqual(original);
});
it('refuses a missing referenced image rather than reclassifying history as disposable', async () => {
  const f = await fixture(); await rm(f.objectPath(f.referenced.attachmentId));
  await expect(inspectOfflineAttachmentCleanup(f.root, f.database)).rejects.toThrow('attachment_cleanup_referenced_object_missing');
  expect(await readFile(f.temporary, 'utf8')).toBe('partial');
});
it('never treats malformed staging names or another digest bucket as disposable', async () => {
  const f = await fixture(), folder = dirname(f.temporary);
  const validName = basename(f.temporary), digest = validName.slice(0, 64);
  for (const name of [digest + '.' + '-'.repeat(36) + '.tmp',
    validName.replace(/\.[a-f0-9-]{36}\.tmp$/u, '.00000000-0000-1000-8000-000000000001.tmp'),
    (digest.startsWith('00') ? 'ff' : '00') + validName.slice(2)]) {
    const unknown = join(folder, name); await writeFile(unknown, 'Unowned staging sentinel');
    await expect(inspectOfflineAttachmentCleanup(f.root, f.database)).rejects.toThrow('attachment_cleanup_object_invalid');
    expect(await readFile(unknown, 'utf8')).toBe('Unowned staging sentinel'); await rm(unknown);
  }
  expect(await readFile(f.temporary, 'utf8')).toBe('partial');
});
it('deletes only the selected orphan category and retains immutable references, temporary bytes and its durable receipt', async () => {
  const f = await fixture(), plan = await inspectOfflineAttachmentCleanup(f.root, f.database);
  const reference = await readFile(f.objectPath(f.referenced.attachmentId));
  const result = await executeOfflineAttachmentCleanup(f.root, f.database, plan.version, ['orphan-attachment']);
  expect(result).toMatchObject({ status: 'completed', filesDeleted: 1, bytesDeleted: f.orphan.bytes, filesRetained: 0, auditRecorded: true });
  await expect(readFile(f.objectPath(f.orphan.attachmentId))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(f.objectPath(f.referenced.attachmentId))).toEqual(reference);
  expect(await readFile(f.temporary, 'utf8')).toBe('partial');
  const scope = join(f.root, 'data/conversation/attachments/v1/cleanup-receipts', result.operationId);
  expect(await readdir(scope)).toEqual(['receipt.jsonl']);
  const records = (await readFile(join(scope, 'receipt.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(records.map(row => row.type).slice(1)).toEqual(['claim-pending', 'claim-verified', 'deleted', 'completed']);
  expect(records[0]).toMatchObject({ planVersion: plan.version, plannedFiles: 1 });
  expect(await inspectOfflineAttachmentCleanup(f.root, f.database)).toMatchObject({ referencedObjects: 1, orphanObjects: 0, unpublishedObjects: 1 });
});
it('rejects a stale inventory before writing any receipt or deleting any candidate', async () => {
  const f = await fixture(), plan = await inspectOfflineAttachmentCleanup(f.root, f.database);
  await writeFile(f.temporary, 'Changed unpublished generation');
  await expect(executeOfflineAttachmentCleanup(f.root, f.database, plan.version, ['orphan-attachment'])).rejects.toThrow('attachment_cleanup_preview_changed');
  expect(await readFile(f.objectPath(f.orphan.attachmentId))).toHaveLength(f.orphan.bytes);
  await expect(readdir(join(f.root, 'data/conversation/attachments/v1/cleanup-receipts'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('records an interrupted claim without deleting any source bytes on an I/O failure', async () => {
  const f = await fixture(), plan = await inspectOfflineAttachmentCleanup(f.root, f.database); faults.claim = 'fail';
  const result = await executeOfflineAttachmentCleanup(f.root, f.database, plan.version, ['orphan-attachment', 'unpublished-attachment']);
  expect(result).toMatchObject({ status: 'interrupted', filesDeleted: 0, bytesDeleted: 0, filesRetained: 2 });
  expect(await readFile(f.objectPath(f.orphan.attachmentId))).toHaveLength(f.orphan.bytes);
  expect(await readFile(f.temporary, 'utf8')).toBe('partial');
  const receipt = await readFile(join(f.root, 'data/conversation/attachments/v1/cleanup-receipts', result.operationId, 'receipt.jsonl'), 'utf8');
  expect(receipt).toContain('claim-pending'); expect(receipt).toContain('interrupted'); expect(receipt).not.toContain('claim-verified');
});
it('retains changed claimed bytes as evidence and never retries them as an ordinary orphan', async () => {
  const f = await fixture(), plan = await inspectOfflineAttachmentCleanup(f.root, f.database); faults.claim = 'replace';
  const result = await executeOfflineAttachmentCleanup(f.root, f.database, plan.version, ['orphan-attachment']);
  expect(result).toMatchObject({ status: 'interrupted', filesDeleted: 0, filesRetained: 1 });
  const scope = join(f.root, 'data/conversation/attachments/v1/cleanup-receipts', result.operationId);
  const retained = (await readdir(scope)).find(name => name.endsWith('.object'))!;
  expect(await readFile(join(scope, retained), 'utf8')).toBe('Synthetic unexpected claimed bytes');
  expect(await inspectOfflineAttachmentCleanup(f.root, f.database)).toMatchObject({ referencedObjects: 1, orphanObjects: 0, unpublishedObjects: 1 });
  expect(await readFile(f.objectPath(f.referenced.attachmentId))).toHaveLength(f.referenced.bytes);
});
it('rejects empty selections after cleanup while preserving the original receipt and protected reference', async () => {
  const f = await fixture(), plan = await inspectOfflineAttachmentCleanup(f.root, f.database);
  const result = await executeOfflineAttachmentCleanup(f.root, f.database, plan.version, ['orphan-attachment', 'unpublished-attachment']);
  expect(result).toMatchObject({ status: 'completed', filesDeleted: 2, bytesDeleted: f.orphan.bytes + 7, filesRetained: 0 });
  const empty = await inspectOfflineAttachmentCleanup(f.root, f.database);
  await expect(executeOfflineAttachmentCleanup(f.root, f.database, empty.version, ['unpublished-attachment'])).rejects.toThrow('attachment_cleanup_selection_empty');
  expect(await readdir(join(f.root, 'data/conversation/attachments/v1/cleanup-receipts'))).toEqual([result.operationId]);
});

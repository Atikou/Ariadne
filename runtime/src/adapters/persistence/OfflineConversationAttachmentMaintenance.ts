import { createHash } from 'node:crypto';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isUnpublishedConversationAttachmentObjectName } from '@ariadne/protocol/host';
import { parseMessageVersionRow, type MessageVersionRow } from './conversation/rows/ConversationAuthorityRowMapper.js';

const MAX_OBJECTS = 20_000, MAX_BYTES = 1536 * 1024;
const OBJECT_ROOT = 'data/conversation/attachments/v1/objects';
export interface OfflineAttachmentCleanupEntry {
  readonly path: string; readonly category: 'orphan-attachment' | 'unpublished-attachment';
  readonly bytes: number; readonly sha256: string; readonly dev: string; readonly inode: string; readonly modifiedAt: string;
}
export interface OfflineAttachmentCleanupPlan {
  readonly version: string; readonly entries: readonly OfflineAttachmentCleanupEntry[];
  readonly referencedObjects: number; readonly orphanObjects: number; readonly orphanBytes: number;
  readonly unpublishedObjects: number; readonly unpublishedBytes: number;
}

/** Caller retains all validated offline original-owner leases. Every immutable
 * Conversation version participates, including archived Sessions and lineage;
 * current heads alone cannot prove an attachment orphan. No history, Core Run,
 * draft, valid snapshot or recovery receipt is a cleanup candidate. */
export async function inspectOfflineAttachmentCleanup(dataRoot: string, conversation: DatabaseSync): Promise<OfflineAttachmentCleanupPlan> {
  if (!path.isAbsolute(dataRoot)) throw new Error('attachment_cleanup_root_invalid');
  const root = await realpath(dataRoot), physical = await lstat(root, { bigint: true });
  if ((await lstat(dataRoot)).isSymbolicLink() || !physical.isDirectory() || physical.ino === 0n) throw new Error('attachment_cleanup_root_invalid');
  const authority = createHash('sha256'), referenced = new Set<string>();
  for (const row of conversation.prepare('SELECT * FROM conversation_message_versions ORDER BY message_id,version').iterate()) {
    const message = parseMessageVersionRow(row as unknown as MessageVersionRow, 'attachment-cleanup-message');
    authority.update(JSON.stringify([message.sessionId, message.workspaceId, message.messageId, message.version, message.contentDigest]) + '\n');
    for (const ref of message.payload.attachments ?? []) {
      // Original ImageAttachmentRef uses sha256:<digest>; object filenames use
      // just the digest, as defined by LocalConversationAttachmentStore.
      referenced.add(ref.attachmentId.slice('sha256:'.length));
      if (referenced.size > MAX_OBJECTS) throw new Error('attachment_cleanup_capacity_exceeded');
    }
  }
  const inventory: { path: string; bytes: number; sha256: string; dev: string; inode: string; modifiedAt: string }[] = [];
  const entries: OfflineAttachmentCleanupEntry[] = [], objects = path.join(root, OBJECT_ROOT);
  let buckets: Awaited<ReturnType<typeof opendir>> | undefined;
  try { await assertOwnedCleanupPath(root, objects); buckets = await opendir(objects); }
  catch (error) { if (!missing(error) || referenced.size !== 0) throw error; }
  let bucketCount = 0;
  if (buckets) for await (const bucket of buckets) {
    if (++bucketCount > 256 || !bucket.isDirectory() || bucket.isSymbolicLink() || !/^[a-f0-9]{2}$/u.test(bucket.name))
      throw new Error('attachment_cleanup_bucket_invalid');
    const bucketPath = path.join(objects, bucket.name); await assertOwnedCleanupPath(root, bucketPath);
    for await (const object of await opendir(bucketPath)) {
      if (inventory.length >= MAX_OBJECTS) throw new Error('attachment_cleanup_capacity_exceeded');
      const published = /^[a-f0-9]{64}$/u.test(object.name) && object.name.startsWith(bucket.name);
      const temporary = isUnpublishedConversationAttachmentObjectName(object.name, bucket.name);
      if (!object.isFile() || object.isSymbolicLink() || (!published && !temporary)) throw new Error('attachment_cleanup_object_invalid');
      const relative = OBJECT_ROOT + '/' + bucket.name + '/' + object.name;
      const metadata = await inspectCleanupFile(root, relative); inventory.push({ path: relative, ...metadata });
      if (published && metadata.sha256 !== object.name) throw new Error('attachment_cleanup_digest_mismatch');
      if (temporary || !referenced.has(object.name)) entries.push({ path: relative, category: temporary ? 'unpublished-attachment' : 'orphan-attachment', ...metadata });
    }
  }
  inventory.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const present = new Set(inventory.map(entry => path.basename(entry.path)));
  for (const id of referenced) if (!present.has(id)) throw new Error('attachment_cleanup_referenced_object_missing');
  const version = createHash('sha256').update(JSON.stringify({ format: 'ariadne.attachment-cleanup-plan.v1',
    root: [physical.dev.toString(), physical.ino.toString()], authority: authority.digest('hex'), inventory })).digest('hex');
  const orphans = entries.filter(entry => entry.category === 'orphan-attachment'), unpublished = entries.filter(entry => entry.category === 'unpublished-attachment');
  return Object.freeze({ version, entries: Object.freeze(entries), referencedObjects: referenced.size, orphanObjects: orphans.length,
    orphanBytes: orphans.reduce((sum, entry) => sum + entry.bytes, 0), unpublishedObjects: unpublished.length,
    unpublishedBytes: unpublished.reduce((sum, entry) => sum + entry.bytes, 0) });
}

export async function inspectCleanupFile(root: string, relative: string): Promise<Omit<OfflineAttachmentCleanupEntry, 'path' | 'category'>> {
  const filePath = path.resolve(root, relative); await assertOwnedCleanupPath(root, filePath);
  const named = await lstat(filePath, { bigint: true }), file = await open(filePath, 'r'), buffer = Buffer.alloc(128 * 1024);
  try {
    const opened = await file.stat({ bigint: true });
    if (!named.isFile() || named.ino === 0n || named.dev !== opened.dev || named.ino !== opened.ino || named.size !== opened.size
      || named.mtimeNs !== opened.mtimeNs || opened.size > BigInt(MAX_BYTES)) throw new Error('attachment_cleanup_file_invalid');
    const hash = createHash('sha256'); let bytes = 0;
    for (;;) {
      const read = await file.read(buffer, 0, buffer.length, null); if (!read.bytesRead) break;
      bytes += read.bytesRead; if (bytes > MAX_BYTES) throw new Error('attachment_cleanup_file_changed'); hash.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await file.stat({ bigint: true }), final = await lstat(filePath, { bigint: true });
    if (BigInt(bytes) !== opened.size || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || final.isSymbolicLink()
      || final.ino !== opened.ino || final.dev !== opened.dev || final.size !== opened.size || final.mtimeNs !== opened.mtimeNs)
      throw new Error('attachment_cleanup_file_changed');
    return { bytes, sha256: hash.digest('hex'), dev: opened.dev.toString(), inode: opened.ino.toString(), modifiedAt: opened.mtimeNs.toString() };
  } finally { buffer.fill(0); await file.close(); }
}
export async function assertOwnedCleanupPath(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw new Error('attachment_cleanup_path_invalid');
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment); if ((await lstat(current)).isSymbolicLink()) throw new Error('attachment_cleanup_path_alias');
  }
  if (await realpath(target) !== target) throw new Error('attachment_cleanup_path_alias');
}
function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }

import { addFixtureProvider } from './support/remote-provider-fixture';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parse, stringify } from 'smol-toml';
import { afterEach, expect, it } from 'vitest';
import { AgentSettingsRepository } from '../src/main/persistence/agent-settings-repository';
import { ChatDraftRepository } from '../src/main/persistence/chat-draft-repository';
import { FileDraftRepository } from '../src/main/persistence/file-draft-repository';
import { TaskNotificationReceipts, validateTaskNotificationBackup } from '../src/main/persistence/task-notification-receipts';
import type { SecretCipher } from '../src/main/persistence/secret-cipher';

// Authenticated unit fixture. This does not assert Electron/Windows key recovery.
const key = randomBytes(32), roots: string[] = [];
const cipher: SecretCipher = {
  encrypt(value) { const iv = randomBytes(12), seal = createCipheriv('aes-256-gcm', key, iv);
    const bytes = Buffer.concat([seal.update(value, 'utf8'), seal.final()]);
    return Buffer.concat([iv, seal.getAuthTag(), bytes]).toString('base64'); },
  decrypt(value) { const bytes = Buffer.from(value, 'base64'), open = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    open.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([open.update(bytes.subarray(28)), open.final()]).toString('utf8'); }
};
async function root() { const path = await mkdtemp(join(tmpdir(), 'Ariadne-readonly-backup-')); roots.push(path); return path; }
afterEach(async () => { for (const path of roots.splice(0)) {
  const scoped = relative(resolve(tmpdir()), resolve(path));
  if (!scoped || scoped.startsWith('..') || isAbsolute(scoped) || !basename(path).startsWith('Ariadne-readonly-backup-')) throw new Error('cleanup_outside_fixture');
  await rm(path, { recursive: true, force: true });
} });

it('validates the actual current settings writer and credentials without migrating or changing live settings', async () => {
  const file = join(await root(), 'settings.toml'), owner = new AgentSettingsRepository(file, cipher);
  await owner.initialize(); owner.validateBackup(await readFile(file, 'utf8'));
  const mutation = await owner.mutate({ expectedRevision: owner.getView().revision,
    operations: [addFixtureProvider('openai', 'PRIVATE_UNIT_FIXTURE')] });
  expect(mutation.ok).toBe(true);
  const raw = await readFile(file, 'utf8'), before = owner.getView(); owner.validateBackup(raw);
  const damaged = parse(raw); (damaged.providers as Record<string, Record<string, unknown>>).openai!.encryptedApiKey = randomBytes(64).toString('base64');
  expect(() => owner.validateBackup(stringify(damaged))).toThrow();
  const old = parse(raw); old.schemaVersion = 6;
  expect(() => owner.validateBackup(stringify(old))).toThrow('current_format_required');
  const missing = parse(raw); delete ((missing.providers as Record<string, Record<string, unknown>>).openai!).modelId;
  expect(() => owner.validateBackup(stringify(missing))).toThrow();
  expect(await readFile(file, 'utf8')).toBe(raw); expect(owner.getView()).toEqual(before);
});

it('uses the original private draft readers, including attachment ownership, and rejects invalid sealed content', async () => {
  const directory = await root(), chatFile = join(directory, 'chat-drafts.json'), filePath = join(directory, 'file-drafts.json');
  const chat = new ChatDraftRepository(chatFile, cipher), files = new FileDraftRepository(filePath, cipher);
  await chat.initialize(); await files.initialize(); const attachmentId = randomUUID();
  await chat.write({ owner: { workspaceId: 'workspace-a', target: { kind: 'new', draftId: randomUUID() } }, expectedStorageRevision: null,
    editing: { revision: 1, generation: randomUUID(), imageEpoch: 0, updatedAt: new Date().toISOString(), text: 'PRIVATE_DRAFT',
      attachments: [{ attachmentId, mediaType: 'image/png', bytes: 3 }] }, submissions: [],
    uploads: [{ attachmentId, attachment: { mediaType: 'image/png', data: 'YWJj' } }] });
  await files.replace({ expectedRevision: 0, records: [{ draftId: randomUUID(), workspaceId: 'workspace-a', path: 'notes.txt', revision: 1,
    updatedAt: new Date().toISOString(), content: 'PRIVATE_UNSAVED', originalContent: 'baseline', version: 'workspace-file-v1:' + 'a'.repeat(64),
    writable: true, exists: true, pendingMutation: null }] });
  const chatRaw = await readFile(chatFile, 'utf8'), fileRaw = await readFile(filePath, 'utf8');
  const chatBefore = chat.list(), fileBefore = await files.list();
  chat.validateBackup(chatRaw); files.validateBackup(fileRaw);
  const wrong: SecretCipher = { encrypt: cipher.encrypt, decrypt: () => { throw new Error('wrong_fixture_key'); } };
  expect(() => new ChatDraftRepository(chatFile, wrong).validateBackup(chatRaw)).toThrow('wrong_fixture_key');
  expect(() => new FileDraftRepository(filePath, wrong).validateBackup(fileRaw)).toThrow('wrong_fixture_key');
  expect(chat.list()).toEqual(chatBefore); expect(await files.list()).toEqual(fileBefore);
  expect(await readFile(chatFile, 'utf8')).toBe(chatRaw); expect(await readFile(filePath, 'utf8')).toBe(fileRaw);
});

it('keeps delivery attempts and shown history unchanged, rejecting bad rows and unknown schemas read-only', async () => {
  const file = join(await root(), 'notification-delivery.db'), owner = new TaskNotificationReceipts(file);
  await owner.initialize(); owner.configure({ completed: true, failed: false });
  owner.shown({ runId: 'run-a', workspaceId: 'workspace-a', sessionId: 'session-a', version: 8, state: 'completed', sourceStatus: 'completed' });
  owner.close(); let bytes = await readFile(file); validateTaskNotificationBackup(file); expect(await readFile(file)).toEqual(bytes);
  let db = new DatabaseSync(file); db.exec("UPDATE notification_delivery SET retry_after=-1"); db.close();
  bytes = await readFile(file); expect(() => validateTaskNotificationBackup(file)).toThrow(); expect(await readFile(file)).toEqual(bytes);
  db = new DatabaseSync(file); db.exec('PRAGMA user_version=9'); db.close();
  bytes = await readFile(file); expect(() => validateTaskNotificationBackup(file)).toThrow('format_unknown'); expect(await readFile(file)).toEqual(bytes);
});

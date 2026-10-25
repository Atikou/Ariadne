import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatDraftRepository } from '../src/main/persistence/chat-draft-repository';
import type { ChatDraftOwner, ChatDraftWrite } from '../src/shared/chat-drafts';
import type { SecretCipher } from '../src/main/persistence/secret-cipher';

const roots: string[] = [], key = randomBytes(32);
const cipher: SecretCipher = {
  encrypt(value) { const iv = randomBytes(12), seal = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([seal.update(value, 'utf8'), seal.final()]);
    return Buffer.concat([iv, seal.getAuthTag(), ciphertext]).toString('base64'); },
  decrypt(value) { const raw = Buffer.from(value, 'base64'), open = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    open.setAuthTag(raw.subarray(12, 28)); return Buffer.concat([open.update(raw.subarray(28)), open.final()]).toString('utf8'); }
};
const owner: ChatDraftOwner = { workspaceId: 'workspace-a', target: { kind: 'new', draftId: randomUUID() } };
const input = (overrides: Partial<ChatDraftWrite> = {}): ChatDraftWrite => ({ owner, expectedStorageRevision: null,
  editing: { revision: 1, generation: randomUUID(), imageEpoch: 0, updatedAt: new Date().toISOString(), text: 'PRIVATE_DRAFT_中文', attachments: [] },
  submissions: [], uploads: [], ...overrides });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'ariadne-chat-drafts-')); roots.push(root);
  const file = join(root, 'drafts.json'), store = new ChatDraftRepository(file, cipher); await store.initialize(); return { file, store }; }
afterEach(async () => { for (const root of roots.splice(0)) {
  const scoped = relative(resolve(tmpdir()), resolve(root));
  if (!scoped || scoped.startsWith('..') || isAbsolute(scoped) || !basename(root).startsWith('ariadne-chat-drafts-')) throw new Error('draft_cleanup_outside_fixture');
  await rm(root, { recursive: true, force: true });
} });
describe('Main private draft owner', () => {
  it('seals private text and separate attachment bodies in one atomic ownership commit and restores metadata without bodies', async () => {
    const { file, store } = await fixture(), attachmentId = randomUUID(), request = input();
    request.editing.attachments = [{ attachmentId, bytes: 3, mediaType: 'image/png', name: 'PRIVATE_IMAGE_NAME' }];
    request.uploads = [{ attachmentId, attachment: { mediaType: 'image/png', data: 'YWJj', name: 'PRIVATE_IMAGE_NAME' } }];
    const row = await store.write(request); const raw = await readFile(file, 'utf8');
    expect(raw).not.toContain('PRIVATE'); expect(raw).not.toContain('YWJj'); expect(raw).not.toContain(owner.workspaceId);
    const reopened = new ChatDraftRepository(file, cipher); await reopened.initialize();
    expect(reopened.list()).toEqual([row]); expect(JSON.stringify(reopened.list())).not.toContain('YWJj');
    expect(reopened.readAttachment({ owner, attachmentId })).toEqual(request.uploads[0]!.attachment);
  });
  it('serializes owner revisions, rejects late writes and permits subsequent valid writes after a rejected CAS', async () => {
    const { store } = await fixture(), first = input(); await store.write(first);
    const results = await Promise.allSettled([
      store.write({ ...first, expectedStorageRevision: 1, editing: { ...first.editing, revision: 2, text: 'B' } }),
      store.write({ ...first, expectedStorageRevision: 1, editing: { ...first.editing, revision: 3, text: 'LATE_A' } })
    ]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']); expect(store.list()[0]!.editing.text).toBe('B');
    await store.write({ ...first, expectedStorageRevision: 2, editing: { ...first.editing, revision: 4, text: 'C' } });
    expect(store.list()[0]!.editing.text).toBe('C');
    await expect(store.write({ ...first, expectedStorageRevision: 3 })).rejects.toThrow('editing_revision_conflict');
    expect(store.list()[0]!.editing.text).toBe('C');
  });
  it('cannot read or steal another owner attachment and preserves bodies referenced by failed submission snapshots', async () => {
    const { store } = await fixture(), request = input(), attachmentId = randomUUID();
    const reference = { attachmentId, bytes: 3, mediaType: 'image/png' as const };
    request.editing.attachments = [reference]; request.uploads = [{ attachmentId, attachment: { mediaType: 'image/png', data: 'YWJj' } }];
    await store.write(request);
    const other: ChatDraftOwner = { workspaceId: 'workspace-b', target: { kind: 'session', sessionId: 'session-b' } };
    expect(() => store.readAttachment({ owner: other, attachmentId })).toThrow('not_owned');
    await expect(store.write({ ...request, owner: other })).rejects.toThrow('identity_conflict');
    const next = await store.write({ ...request, expectedStorageRevision: 1, uploads: [],
      editing: { ...request.editing, revision: 2, attachments: [], text: 'B' },
      submissions: [{ submissionId: randomUUID(), submittedRevision: 1, nextEditingRevision: 2, text: 'A', attachments: [reference], status: 'recoverable', commandIds: [] }] });
    expect(store.readAttachment({ owner, attachmentId }).data).toBe('YWJj');
    await store.write({ owner, expectedStorageRevision: next.storageRevision, editing: next.editing, submissions: [], uploads: [] });
    expect(() => store.readAttachment({ owner, attachmentId })).toThrow('not_owned');
  });
  it('moves a new draft and its private attachment ownership to a created session atomically, fencing old-owner saves', async () => {
    const { store, file } = await fixture(), request = input(), attachmentId = randomUUID();
    request.editing.attachments = [{ attachmentId, bytes: 3, mediaType: 'image/png' }];
    request.uploads = [{ attachmentId, attachment: { mediaType: 'image/png', data: 'YWJj' } }]; await store.write(request);
    const target: ChatDraftOwner = { workspaceId: owner.workspaceId, target: { kind: 'session', sessionId: 'session-created' } };
    await store.move({ from: owner, to: target, expectedFromRevision: 1, expectedToRevision: null });
    expect(store.list().map(row => row.owner)).toEqual([target]);
    expect(() => store.readAttachment({ owner, attachmentId })).toThrow('not_owned');
    expect(store.readAttachment({ owner: target, attachmentId }).data).toBe('YWJj');
    await expect(store.write({ ...request, expectedStorageRevision: 1 })).rejects.toThrow('revision_conflict');
    const reopened = new ChatDraftRepository(file, cipher); await reopened.initialize(); expect(reopened.list()[0]!.owner).toEqual(target);
  });
  it('rejects populated migration targets without discarding either draft and rejects arbitrary paths in logical owners', async () => {
    const { store } = await fixture(), target: ChatDraftOwner = { workspaceId: owner.workspaceId, target: { kind: 'session', sessionId: 'session-existing' } };
    await store.write(input()); await store.write(input({ owner: target }));
    await expect(store.move({ from: owner, to: target, expectedFromRevision: 1, expectedToRevision: 1 })).rejects.toThrow('target_not_empty');
    expect(store.list()).toHaveLength(2);
    await expect(store.write(input({ owner: { workspaceId: '../../outside', target: owner.target } }))).rejects.toThrow();
  });
  it('preserves malformed or undecryptable sources, disables its writes and keeps initialization/flush isolated', async () => {
    const { file } = await fixture(), original = '{"PRIVATE_BAD_DRAFT":"retain"}'; await writeFile(file, original);
    const logged = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const store = new ChatDraftRepository(file, cipher); await store.initialize();
      expect(() => store.list()).toThrow('storage_unavailable'); await expect(store.write(input())).rejects.toThrow('storage_unavailable');
      await store.flush(); expect(await readFile(file, 'utf8')).toBe(original);
    } finally { logged.mockRestore(); }
  });
});

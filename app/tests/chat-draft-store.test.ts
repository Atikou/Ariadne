import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatDraftStore } from '../src/renderer/src/core/conversations/chat-draft-store';
import { chatDraftOwnerKey, type ChatDraftApi, type ChatDraftOwner, type ChatDraftRecord, type ChatDraftWrite } from '../src/shared/chat-drafts';
import type { EncodedImageAttachment } from '@ariadne/protocol/public';

const stores: ChatDraftStore[] = [];
const owner = (id = 'session-a'): ChatDraftOwner => ({ workspaceId: 'workspace-a', target: { kind: 'session', sessionId: id } });
function fixture() {
  const records = new Map<string, ChatDraftRecord>(), bodies = new Map<string, EncodedImageAttachment>();
  const api = {
    list: vi.fn(async () => structuredClone([...records.values()])),
    write: vi.fn(async (request: ChatDraftWrite) => {
      const row: ChatDraftRecord = structuredClone({ owner: request.owner, editing: request.editing, submissions: request.submissions,
        storageRevision: (request.expectedStorageRevision ?? 0) + 1 });
      records.set(chatDraftOwnerKey(row.owner), row); for (const upload of request.uploads) bodies.set(upload.attachmentId, upload.attachment); return row;
    }),
    move: vi.fn<ChatDraftApi['move']>(async request => {
      const old = records.get(chatDraftOwnerKey(request.from))!;
      const moved = { ...structuredClone(old), owner: request.to, storageRevision: (request.expectedToRevision ?? 0) + 1 };
      records.delete(chatDraftOwnerKey(request.from)); records.set(chatDraftOwnerKey(request.to), moved); return moved;
    }),
    readAttachment: vi.fn<ChatDraftApi['readAttachment']>(async request => { const body = bodies.get(request.attachmentId);
      if (!body) throw new Error('attachment_not_found'); return body; })
  };
  const store = new ChatDraftStore(api); stores.push(store); return { store, api, records, bodies };
}
function image() { return { clientId: crypto.randomUUID(), bytes: 3, mediaType: 'image/png' as const, data: 'YWJj', name: 'private.png' }; }
afterEach(() => { for (const store of stores.splice(0)) store.dispose(); });
describe('owner and revision bound editing snapshots', () => {
  it('keeps the editor identity through submission and session migration but separates explicitly new drafts', async () => {
    const f = fixture(); await f.store.initialize(); const initial = f.store.newDraft('workspace-a');
    const editorId = f.store.draft(initial).editorId;
    f.store.edit(initial, 'A'); await f.store.beginSubmission(initial);
    expect(f.store.draft(initial).editorId).toBe(editorId);
    await f.store.moveToSession(initial, 'created');
    expect(f.store.draft(owner('created')).editorId).toBe(editorId);
    const next = f.store.newDraft('workspace-a');
    expect(f.store.draft(next).editorId).not.toBe(editorId);
    await f.store.flush();
    expect(JSON.stringify([...f.records.values()])).not.toContain('editorId');
  });
  it('coalesces concurrent restore requests instead of replacing in-flight local ownership', async () => {
    const f = fixture(); let release!: () => void;
    f.api.list.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return []; });
    const first = f.store.initialize(), second = f.store.initialize();
    expect(first).toBe(second); expect(f.api.list).toHaveBeenCalledTimes(1);
    release(); await first; expect(f.store.getSnapshot().ready).toBe(true);
  });
  it('atomically saves retained A images and new B images with independent per-message limits', async () => {
    const f = fixture(); await f.store.initialize();
    f.store.appendImages(f.store.captureImageRead(owner()), [image(), image(), image(), image()]);
    const token = await f.store.beginSubmission(owner());
    f.store.appendImages(f.store.captureImageRead(owner()), [image(), image(), image(), image()]);
    f.store.fail(token); await f.store.flush();
    const row = f.records.get(chatDraftOwnerKey(owner()))!;
    expect(row.editing.attachments).toHaveLength(4); expect(row.submissions[0]!.attachments).toHaveLength(4);
  });
  it('uses stable independent new-draft identities and preserves earlier new drafts when explicitly creating another', async () => {
    const f = fixture(); await f.store.initialize();
    const a = f.store.ownerFor('workspace-a', null), b = f.store.ownerFor('workspace-b', null);
    expect(f.store.ownerFor('workspace-a', null)).toEqual(a); expect(a).not.toEqual(b);
    f.store.edit(a, 'old new draft'); const next = f.store.newDraft('workspace-a');
    expect(next).not.toEqual(a); expect(f.store.draft(a).editing.text).toBe('old new draft');
    expect(f.store.draft(next).editing.text).toBe(''); await f.store.flush();
  });
  it('preserves B entered during delayed A persistence and retains failed A as a recoverable snapshot', async () => {
    const f = fixture(); await f.store.initialize(); f.store.select(owner()); f.store.edit(owner(), 'A');
    const original = f.api.write.getMockImplementation()!; let release!: () => void;
    f.api.write.mockImplementationOnce(async request => { const saved = await original(request);
      await new Promise<void>(resolve => { release = resolve; }); return saved; });
    const submitted = f.store.beginSubmission(owner()); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    f.store.edit(owner(), 'B'); release(); const token = await submitted; f.store.fail(token);
    expect(f.store.draft(owner()).editing.text).toBe('B');
    expect(f.store.draft(owner()).submissions).toMatchObject([{ text: 'A', status: 'recoverable' }]); await f.store.flush();
    expect(f.records.get(chatDraftOwnerKey(owner()))!.editing.text).toBe('B');
  });
  it('restores confirmed failure only into the exact untouched next editing revision', async () => {
    const f = fixture(); await f.store.initialize(); f.store.edit(owner(), 'A');
    const token = await f.store.beginSubmission(owner()); f.store.fail(token); f.store.fail(token);
    expect(f.store.draft(owner()).editing.text).toBe('A'); expect(f.store.draft(owner()).submissions).toEqual([]);
    expect(f.store.draft(owner()).editing.revision).toBeGreaterThan(token.editingRevision);
  });
  it('keeps callbacks owned by A after switching the selected session to B', async () => {
    const f = fixture(); await f.store.initialize(); f.store.select(owner()); f.store.edit(owner(), 'A');
    const token = await f.store.beginSubmission(owner()); f.store.select(owner('session-b')); f.store.edit(owner('session-b'), 'B');
    f.store.fail(token); expect(f.store.isSelected(owner('session-b'))).toBe(true);
    expect(f.store.draft(owner()).editing.text).toBe('A'); expect(f.store.draft(owner('session-b')).editing.text).toBe('B');
  });
  it('appends concurrent image reads atomically to their owner, and fences reads after removal or send', async () => {
    const f = fixture(); await f.store.initialize(); f.store.select(owner());
    const first = f.store.captureImageRead(owner()), second = f.store.captureImageRead(owner());
    f.store.select(owner('session-b')); const a = image(), b = image();
    expect(f.store.appendImages(first, [a])).toBe(true); expect(f.store.appendImages(second, [b])).toBe(true);
    expect(f.store.draft(owner()).editing.attachments.map(row => row.attachmentId)).toEqual([a.clientId, b.clientId]);
    expect(f.store.draft(owner('session-b')).editing.attachments).toEqual([]);
    const removed = f.store.captureImageRead(owner()); f.store.removeImage(owner(), a.clientId);
    expect(f.store.appendImages(removed, [image()])).toBe(false);
    const sent = f.store.captureImageRead(owner()); const token = await f.store.beginSubmission(owner());
    expect(f.store.appendImages(sent, [image()])).toBe(false); f.store.complete(token);
    expect(JSON.stringify(f.store.getSnapshot())).not.toContain('YWJj');
  });
  it('moves the stable new owner while retaining typing during migration and redirects late callbacks to that session', async () => {
    const f = fixture(); await f.store.initialize(); const initial = f.store.ownerFor('workspace-a', null);
    f.store.select(initial); f.store.edit(initial, 'A'); const token = await f.store.beginSubmission(initial);
    const original = f.api.move.getMockImplementation()!; let release!: () => void;
    f.api.move.mockImplementationOnce(async request => { const row = await original(request); await new Promise<void>(resolve => { release = resolve; }); return row; });
    const migrating = f.store.moveToSession(initial, 'session-created'); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    f.store.edit(initial, 'B during migration'); const saving = f.store.flush(); release(); await migrating; await saving;
    f.store.fail(token); const created = owner('session-created');
    expect(f.store.draft(created).editing.text).toBe('B during migration'); expect(f.store.draft(created).submissions[0]!.text).toBe('A');
    expect(f.store.isSelected(created)).toBe(true); await f.store.flush();
    expect(f.records.has(chatDraftOwnerKey(initial))).toBe(false); expect(f.records.get(chatDraftOwnerKey(created))!.editing.text).toBe('B during migration');
  });
  it('notifies session selection after durable migration before React can materialize the next new draft', async () => {
    const f = fixture(); await f.store.initialize(); const initial = f.store.newDraft('workspace-a');
    f.store.edit(initial, 'A'); const token = await f.store.beginSubmission(initial);
    let selectedSession: string | null = null;
    f.store.subscribe(() => {
      if (selectedSession === null && f.store.draft(initial).owner.target.kind === 'session')
        f.store.select(f.store.ownerFor('workspace-a', null));
    });
    await f.store.moveToSession(initial, 'session-created', () => {
      expect(f.records.get(chatDraftOwnerKey(owner('session-created')))).toBeDefined();
      if (f.store.isSelected(token.owner)) selectedSession = 'session-created';
    });
    expect(selectedSession).toBe('session-created'); expect(f.store.isSelected(owner('session-created'))).toBe(true);
  });
  it('keeps an explicit user switch made during durable migration when selecting the created session', async () => {
    const f = fixture(); await f.store.initialize(); const initial = f.store.newDraft('workspace-a');
    f.store.edit(initial, 'A'); const token = await f.store.beginSubmission(initial);
    const original = f.api.move.getMockImplementation()!; let release!: () => void;
    f.api.move.mockImplementationOnce(async request => { await new Promise<void>(resolve => { release = resolve; }); return original(request); });
    let selectedSession = 'session-b';
    const moving = f.store.moveToSession(initial, 'session-created', () => {
      if (f.store.isSelected(token.owner)) selectedSession = 'session-created';
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function')); f.store.select(owner('session-b')); release(); await moving;
    expect(selectedSession).toBe('session-b'); expect(f.store.isSelected(owner('session-b'))).toBe(true);
  });
  it('does not restore or resend an uncertain submission, retains exact command references and leaves B intact on acceptance', async () => {
    const f = fixture(); await f.store.initialize(); f.store.edit(owner(), 'A'); const token = await f.store.beginSubmission(owner());
    await f.store.attachCommand(token, 'original-command-a'); f.store.edit(owner(), 'B'); f.store.fail(token, true);
    expect(f.store.draft(owner()).submissions[0]).toMatchObject({ status: 'reconcile', commandIds: ['original-command-a'] });
    await expect(f.store.beginSubmission(owner())).rejects.toThrow('submission_unavailable');
    f.store.complete(token); expect(f.store.draft(owner()).editing.text).toBe('B'); expect(f.store.draft(owner()).submissions).toEqual([]);
  });
  it('offers explicit recovery of failed A without replacing already edited B', async () => {
    const f = fixture(); await f.store.initialize(); f.store.edit(owner(), 'A'); const token = await f.store.beginSubmission(owner());
    f.store.edit(owner(), 'B'); f.store.fail(token); f.store.restore(owner(), token.submissionId);
    expect(f.store.draft(owner()).editing.text).toBe('B\nA'); expect(f.store.draft(owner()).submissions).toEqual([]);
  });
  it('retains the original text when secure persistence fails before any sender dispatch', async () => {
    const f = fixture(); await f.store.initialize(); f.store.edit(owner(), 'A');
    f.api.write.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(f.store.beginSubmission(owner())).rejects.toThrow('persistence_failed');
    expect(f.store.draft(owner()).editing.text).toBe('A'); expect(f.store.getSnapshot().error).toBeTruthy();
    await expect(f.store.beginSubmission(owner())).rejects.toThrow('storage_unavailable');
  });
  it('discards a late body read after its reference was removed and restores metadata after window reconstruction', async () => {
    const f = fixture(); await f.store.initialize(); const photo = image(); f.store.appendImages(f.store.captureImageRead(owner()), [photo]); await f.store.flush();
    const next = new ChatDraftStore(f.api); stores.push(next); await next.initialize();
    expect(JSON.stringify(next.getSnapshot())).not.toContain('YWJj');
    let release!: () => void; f.api.readAttachment.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return { mediaType: 'image/png', data: 'YWJj' }; });
    const loading = next.attachment(owner(), next.draft(owner()).editing.attachments[0]!); next.removeImage(owner(), photo.clientId); release();
    await expect(loading).rejects.toThrow('no_longer_owned'); expect(next.draft(owner()).editing.attachments).toEqual([]);
  });
});

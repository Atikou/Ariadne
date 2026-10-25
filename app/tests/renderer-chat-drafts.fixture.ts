// In-memory UI fixture only. No Main, OS encryption, Core or Provider claim.
import { PERSONAL_ASSISTANT_WORKSPACE_ID, type EncodedImageAttachment } from '@ariadne/protocol/public';
import { ChatDraftStore } from '../src/renderer/src/core/conversations/chat-draft-store';
import { chatDraftOwnerKey, type ChatDraftApi, type ChatDraftOwner, type ChatDraftRecord } from '../src/shared/chat-drafts';

export const chatFixtureOwner = (sessionId: string): ChatDraftOwner => ({ workspaceId: PERSONAL_ASSISTANT_WORKSPACE_ID, target: { kind: 'session', sessionId } });
const picture: EncodedImageAttachment = { mediaType: 'image/png', name: '【UI夹具】图片.png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWMwTpv5HwAENAIyeXoBdAAAAABJRU5ErkJggg==' };
const imageId = crypto.randomUUID();
const records = new Map<string, ChatDraftRecord>();
const bodies = new Map<string, EncodedImageAttachment>([[imageId, picture]]);
const initial: ChatDraftRecord = { owner: chatFixtureOwner('fixture-chat-a'), storageRevision: 1, submissions: [],
  editing: { revision: 1, generation: crypto.randomUUID(), imageEpoch: 0, updatedAt: '2026-10-06T00:00:00Z', text: '',
    attachments: [{ attachmentId: imageId, mediaType: picture.mediaType, name: picture.name!, bytes: atob(picture.data).length }] } };
records.set(chatDraftOwnerKey(initial.owner), initial);
let imageFailure = true;
const persistence: ChatDraftApi = {
  list: async () => structuredClone([...records.values()]),
  write: async request => {
    const record: ChatDraftRecord = structuredClone({ owner: request.owner, editing: request.editing, submissions: request.submissions,
      storageRevision: (request.expectedStorageRevision ?? 0) + 1 });
    records.set(chatDraftOwnerKey(record.owner), record); for (const row of request.uploads) bodies.set(row.attachmentId, row.attachment); return record;
  },
  move: async () => { throw new Error('UI fixture does not create a Core session.'); },
  readAttachment: async request => {
    if (imageFailure) throw new Error('UI fixture image read failed');
    const record = records.get(chatDraftOwnerKey(request.owner));
    if (!record?.editing.attachments.some(row => row.attachmentId === request.attachmentId)) throw new Error('UI fixture image owner mismatch');
    const image = bodies.get(request.attachmentId); if (!image) throw new Error('UI fixture image absent'); return image;
  }
};
export const chatFixtureDrafts = new ChatDraftStore(persistence);
void chatFixtureDrafts.initialize();
export const chatDraftUiFixture = {
  allowImageRead: () => { imageFailure = false; },
  draft: (sessionId: string) => chatFixtureDrafts.draft(chatFixtureOwner(sessionId)),
  prepareRecovery: async (sessionId: string) => {
    const owner = chatFixtureOwner(sessionId); chatFixtureDrafts.edit(owner, 'A 保留内容');
    const token = await chatFixtureDrafts.beginSubmission(owner); chatFixtureDrafts.edit(owner, 'B 当前输入');
    chatFixtureDrafts.fail(token); await chatFixtureDrafts.flush();
  }
};

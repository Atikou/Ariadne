import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatDraftOwner, ChatDraftRecord, ChatDraftWrite } from '../src/shared/chat-drafts';
import type { AriadneApi, InputDeliveryOutboxRecord } from '../src/shared/contract';
import { chatDraftOwnerKey } from '../src/shared/chat-drafts';
import { ChatDraftStore } from '../src/renderer/src/core/conversations/chat-draft-store';
import { ChatDraftDelivery } from '../src/renderer/src/core/conversations/chat-draft-delivery';
import type { SendMessageOptions, MessageFeatureStore } from '../src/renderer/src/core/runtime/features/message-feature-store';
import type { RunFeatureStore } from '../src/renderer/src/core/runtime/features/run-feature-store';
import { ConversationDeliveryError } from '../src/renderer/src/core/runtime/features/conversation-input-delivery-controller';
import type { AgentInputDeliveryReceipt } from '../src/renderer/src/core/runtime/agent-input-delivery';
const owner: ChatDraftOwner = { workspaceId: 'workspace-a', target: { kind: 'session', sessionId: 'session-a' } };
const stores: ChatDraftStore[] = [];
const coordinators: ChatDraftDelivery[] = [];
afterEach(() => { for (const coordinator of coordinators.splice(0)) coordinator.dispose(); for (const store of stores.splice(0)) store.dispose(); });
async function fixture() {
  const persisted = new Map<string, ChatDraftRecord>();
  const draftApi = { list: vi.fn(async () => [...persisted.values()]),
    write: vi.fn(async (request: ChatDraftWrite) => { const row = structuredClone({ owner: request.owner, editing: request.editing,
      submissions: request.submissions, storageRevision: (request.expectedStorageRevision ?? 0) + 1 }); persisted.set(chatDraftOwnerKey(row.owner), row); return row; }),
    move: vi.fn(), readAttachment: vi.fn() };
  const drafts = new ChatDraftStore(draftApi); stores.push(drafts); await drafts.initialize(); drafts.select(owner); drafts.edit(owner, 'A');
  const messages = { send: vi.fn(async (_text: string, options: SendMessageOptions) => { await options.draft!.onStaged(['original-command']); return { messageId: options.draft!.submissionId, sessionId: 'session-a' }; }),
    reconcileDraftDelivery: vi.fn(), settleDraftDelivery: vi.fn(async (_submissionId: string) => undefined) };
  const receiptListeners = new Set<() => void>();
  const runs = { enqueueInput: vi.fn(), reconcileInputDelivery: vi.fn(), settleDraftDelivery: vi.fn(), dismissInputDelivery: vi.fn(),
    deliverySnapshot: vi.fn((): AgentInputDeliveryReceipt[] => []), view: { subscribe: (listener: () => void) => {
      receiptListeners.add(listener); return () => { receiptListeners.delete(listener); }; } } };
  const outbox = { list: vi.fn(async (): Promise<InputDeliveryOutboxRecord[]> => []), stage: vi.fn(), stageBatch: vi.fn(), settle: vi.fn() } satisfies AriadneApi['inputDeliveryOutbox'];
  let selected: string | null = 'session-a';
  const coordinator = new ChatDraftDelivery(drafts, messages as unknown as MessageFeatureStore, runs as unknown as RunFeatureStore, outbox, () => selected);
  coordinators.push(coordinator);
  return { drafts, draftApi, messages, runs, outbox, coordinator, persisted, select: (id: string | null) => { selected = id; },
    observe: (receipts: AgentInputDeliveryReceipt[]) => { runs.deliverySnapshot.mockReturnValue(receipts); for (const listener of receiptListeners) listener(); } };
}
describe('draft editing and original delivery coordination', () => {
  it('consumes a positive automatic Inbox receipt and persists A settlement before releasing its original envelope while retaining B', async () => {
    const f = await fixture(), token = await f.drafts.beginSubmission(owner);
    await f.drafts.attachCommand(token, 'original-agent-command'); f.drafts.edit(owner, 'B'); f.drafts.fail(token, true); await f.drafts.flush();
    const receipt: AgentInputDeliveryReceipt = { draftSubmissionId: token.submissionId, commandId: 'original-agent-command',
      inputId: token.submissionId, runId: 'run-a', sessionId: 'session-a', content: 'A', delivery: 'next_turn',
      state: 'accepted', attempt: 2, createdAt: '2026-10-06T00:00:00Z', updatedAt: '2026-10-06T00:00:01Z' };
    f.outbox.list.mockResolvedValue([{ commandId: receipt.commandId, draftSubmissionId: token.submissionId, createdAt: receipt.createdAt,
      command: { kind: 'agent.inbox.enqueue', contractVersion: '5.0', runId: receipt.runId, sessionId: receipt.sessionId,
        inputId: receipt.inputId, content: receipt.content, delivery: receipt.delivery } }]);
    f.runs.reconcileInputDelivery.mockResolvedValue(receipt);
    f.runs.settleDraftDelivery.mockImplementation(async () => {
      expect(f.persisted.get(chatDraftOwnerKey(owner))!.submissions).toEqual([]);
      expect(f.persisted.get(chatDraftOwnerKey(owner))!.editing.text).toBe('B');
    });
    f.coordinator.start(); f.observe([receipt]);
    await vi.waitFor(() => expect(f.runs.settleDraftDelivery).toHaveBeenCalledTimes(1));
    expect(f.drafts.draft(owner).editing.text).toBe('B'); expect(f.drafts.draft(owner).submissions).toEqual([]);
    expect(f.messages.send).not.toHaveBeenCalled();
  });
  it('retains the accepted receipt when closing cannot settle its safe original envelope', async () => {
    const f = await fixture(); f.runs.settleDraftDelivery.mockRejectedValueOnce(new Error('safe storage unavailable'));
    await expect(f.coordinator.dismissInputReceipt('original-command', 'known-submission')).rejects.toThrow('safe storage unavailable');
    expect(f.runs.dismissInputDelivery).not.toHaveBeenCalled();
    await f.coordinator.dismissInputReceipt('original-command', 'known-submission'); expect(f.runs.dismissInputDelivery).toHaveBeenCalledWith('original-command');
  });
  it('fixes A session/workspace before dispatch and preserves B on delayed confirmed rejection', async () => {
    const f = await fixture(); let reject!: (error: Error) => void;
    f.messages.send.mockImplementationOnce(async (_text, options) => { await options.draft!.onStaged(['original-command']); return new Promise((_resolve, fail) => { reject = fail; }); });
    const pending = f.coordinator.send(owner, { modelId: 'captured-model' }); await vi.waitFor(() => expect(reject).toBeTypeOf('function'));
    f.drafts.edit(owner, 'B'); f.select('session-b'); f.drafts.select({ ...owner, target: { kind: 'session', sessionId: 'session-b' } });
    const options = f.messages.send.mock.calls[0]![1]; expect(options).toMatchObject({ workspaceId: 'workspace-a', sessionId: 'session-a', modelId: 'captured-model' });
    expect(options.draft!.canSelectSession()).toBe(false);
    reject(new ConversationDeliveryError(false, ['original-command'], new Error('rejected'))); await expect(pending).rejects.toThrow();
    expect(f.drafts.draft(owner).editing.text).toBe('B'); expect(f.drafts.draft(owner).submissions[0]).toMatchObject({ text: 'A', status: 'recoverable' });
    expect(f.persisted.get(chatDraftOwnerKey(owner))!.editing.text).toBe('B'); expect(f.messages.settleDraftDelivery).toHaveBeenCalledTimes(1);
  });
  it('never restores an accepted A when later outbox settlement fails', async () => {
    const f = await fixture(); f.messages.settleDraftDelivery.mockRejectedValueOnce(new Error('settlement disk failure'));
    await expect(f.coordinator.send(owner, {})).rejects.toThrow('settlement disk failure');
    expect(f.drafts.draft(owner).editing.text).toBe(''); expect(f.drafts.draft(owner).submissions).toEqual([]);
    expect(f.persisted.get(chatDraftOwnerKey(owner))!.submissions).toEqual([]);
  });
  it('retains an uncertain A and original references without creating another send from B', async () => {
    const f = await fixture(); f.messages.send.mockImplementationOnce(async (_text, options) => { await options.draft!.onStaged(['original-command']);
      f.drafts.edit(owner, 'B'); throw new ConversationDeliveryError(true, ['original-command'], new Error('unknown')); });
    await expect(f.coordinator.send(owner, {})).rejects.toThrow();
    expect(f.drafts.draft(owner).editing.text).toBe('B'); expect(f.drafts.draft(owner).submissions[0]).toMatchObject({ status: 'reconcile', commandIds: ['original-command'] });
    expect(f.messages.settleDraftDelivery).not.toHaveBeenCalled(); await expect(f.coordinator.send(owner, {})).rejects.toThrow('submission_unavailable');
    expect(f.messages.send).toHaveBeenCalledTimes(1);
  });
  it('recovers a crash before atomic staging only from the authenticated empty sender owner, and refuses missing referenced envelopes', async () => {
    const f = await fixture(); const token = await f.drafts.beginSubmission(owner);
    await f.coordinator.reconcile(owner, token.submissionId); expect(f.drafts.draft(owner).editing.text).toBe('A');
    const next = await f.drafts.beginSubmission(owner); await f.drafts.attachCommand(next, 'existing-reference');
    await expect(f.coordinator.reconcile(owner, next.submissionId)).rejects.toThrow('original_delivery_missing');
    expect(f.drafts.draft(owner).submissions[0]!.status).toBe('submitted'); expect(f.messages.send).not.toHaveBeenCalled();
  });
});

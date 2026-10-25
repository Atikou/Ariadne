import type { AriadneApi } from '@shared/contract';
import type { ChatDraftOwner, ChatDraftSubmission } from '@shared/chat-drafts';
import { chatDraftOwnerKey } from '@shared/chat-drafts';
import type { RuntimeRun } from '../runtime/runtime-projection-presenter';
import type { MessageFeatureStore, SendMessageOptions } from '../runtime/features/message-feature-store';
import type { RunFeatureStore } from '../runtime/features/run-feature-store';
import type { DraftDeliveryBinding } from '../runtime/features/input-delivery-binding';
import { ConversationDeliveryError } from '../runtime/features/conversation-input-delivery-controller';
import { ChatDraftStore, type DraftSubmissionToken } from './chat-draft-store';

/** Editing lifecycle coordination only. Original business commands and replay
 * remain with Message/Run delivery owners and the existing sealed outbox. */
export class ChatDraftDelivery {
  private readonly active = new Set<string>();
  private readonly observedReceipts = new Map<string, string>();
  private removers: (() => void)[] = [];
  private scheduled = false;
  private disposed = false;
  constructor(private readonly drafts: ChatDraftStore, private readonly messages: MessageFeatureStore, private readonly runs: RunFeatureStore,
    private readonly outbox: NonNullable<AriadneApi['inputDeliveryOutbox']>, private readonly selectedSession: () => string | null) {}
  start(): void {
    if (this.removers.length || this.disposed) return;
    this.removers = [this.runs.view.subscribe(() => this.scheduleKnownReceipts()), this.drafts.subscribe(() => this.scheduleKnownReceipts())];
    this.scheduleKnownReceipts();
  }
  dispose(): void { this.disposed = true; for (const remove of this.removers) remove(); this.removers = []; }
  async dismissInputReceipt(commandId: string, submissionId: string): Promise<void> {
    const draft = this.drafts.getSnapshot().drafts.find(row => row.submissions.some(submission => submission.submissionId === submissionId));
    if (draft) await this.reconcile(draft.owner, submissionId);
    else await this.runs.settleDraftDelivery(commandId, submissionId);
    this.runs.dismissInputDelivery(commandId);
  }
  private scheduleKnownReceipts(): void {
    if (this.scheduled || this.disposed || !this.removers.length) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false; if (this.disposed || !this.drafts.getSnapshot().ready) return;
      const receipts = this.runs.deliverySnapshot();
      const retained = new Set(receipts.map(row => row.draftSubmissionId));
      for (const id of this.observedReceipts.keys()) if (!retained.has(id)) this.observedReceipts.delete(id);
      for (const receipt of receipts) {
        const id = receipt.draftSubmissionId;
        if (!id || !['accepted', 'failed'].includes(receipt.state) || this.active.has(id)) continue;
        const draft = this.drafts.getSnapshot().drafts.find(row => row.submissions.some(submission => submission.submissionId === id && submission.status !== 'recoverable'));
        if (!draft) continue;
        const identity = `${receipt.state}|${receipt.attempt}|${receipt.updatedAt}`;
        if (this.observedReceipts.get(id) === identity) continue;
        this.observedReceipts.set(id, identity);
        // This consumes positive evidence from the existing delivery owner,
        // never Projection absence and never a new business command identity.
        void this.reconcile(draft.owner, id).catch(() => undefined);
      }
    });
  }
  async send(owner: ChatDraftOwner, options: Omit<SendMessageOptions, 'sessionId' | 'workspaceId' | 'attachments' | 'draft'>,
    run?: RuntimeRun, delivery: 'next_turn' | 'next_step' = 'next_turn'): Promise<void> {
    if (run && (owner.target.kind !== 'session' || run.sessionId !== owner.target.sessionId || this.drafts.draft(owner).editing.attachments.length))
      throw new Error('运行中输入的会话归属不匹配或包含图片，内容仍已保留。');
    const token = await this.drafts.beginSubmission(owner);
    await this.perform(token, async (binding) => {
      if (run) {
        const receipt = await this.runs.enqueueInput(run, token.text, delivery, binding);
        return { state: receipt.state, commandId: receipt.commandId, agent: true };
      }
      const attachments = await Promise.all(token.attachments.map(reference => this.drafts.attachment(token.owner, reference)));
      await this.messages.send(token.text, { ...options, workspaceId: owner.workspaceId,
        sessionId: owner.target.kind === 'session' ? owner.target.sessionId : null, ...(attachments.length ? { attachments } : {}), draft: binding });
      return { state: 'accepted', agent: false };
    });
  }
  async reconcile(owner: ChatDraftOwner, submissionId: string): Promise<void> {
    const row = this.drafts.draft(owner).submissions.find(item => item.submissionId === submissionId);
    if (!row || row.status === 'recoverable') throw new Error('chat_draft_reconciliation_not_available');
    const token = tokenOf(owner, row);
    const records = (await this.outbox.list()).filter(record => record.draftSubmissionId === submissionId);
    if (records.length === 0) {
      // The authenticated Main list waits for pending writes. With no recorded
      // command references, the atomic stage-before-dispatch invariant proves
      // this snapshot never reached a sender. Projection omission is not used.
      if (row.commandIds.length) throw new Error('chat_draft_original_delivery_missing');
      this.drafts.fail(token); await this.drafts.flush(); return;
    }
    await this.perform(token, async binding => {
      const agent = records.find(record => record.command.kind === 'agent.inbox.enqueue');
      if (agent) {
        if (records.length !== 1) throw new Error('chat_draft_delivery_owner_mismatch');
        await binding.onStaged([agent.commandId]);
        const receipt = await this.runs.reconcileInputDelivery(agent.commandId);
        return { state: receipt.state, commandId: receipt.commandId, agent: true };
      }
      await this.messages.reconcileDraftDelivery(submissionId, binding);
      return { state: 'accepted', agent: false };
    }, true);
  }
  private async perform(token: DraftSubmissionToken,
    operation: (binding: DraftDeliveryBinding) => Promise<{ state: string; commandId?: string; agent: boolean }>, reconciling = false): Promise<void> {
    if (this.active.has(token.submissionId)) throw new Error('chat_draft_delivery_in_progress');
    this.active.add(token.submissionId);
    let staged = reconciling, settled = false;
    const selection = token.owner.target.kind === 'session' ? token.owner.target.sessionId : null;
    const binding: DraftDeliveryBinding = { submissionId: token.submissionId, draftOwnerKey: chatDraftOwnerKey(token.owner),
      onStaged: async ids => { staged = true; for (const id of ids) await this.drafts.attachCommand(token, id); },
      onSessionCreated: (sessionId, afterMove) => this.drafts.moveToSession(token.owner, sessionId, afterMove),
      canSelectSession: () => this.drafts.isSelected(token.owner) && this.selectedSession() === selection };
    try {
      const result = await operation(binding);
      if (result.state === 'accepted') this.drafts.complete(token);
      else if (result.state === 'failed') this.drafts.fail(token);
      else { this.drafts.fail(token, true); await this.drafts.flush(); throw new ConversationDeliveryError(true, [], new Error('input_delivery_reconciliation_required')); }
      settled = true; await this.drafts.flush();
      if (staged) {
        if (result.agent) await this.runs.settleDraftDelivery(result.commandId!, token.submissionId);
        else await this.messages.settleDraftDelivery(token.submissionId);
      }
    } catch (error) {
      // A storage/settlement failure after positive acceptance cannot turn an
      // accepted message back into an editable duplicate.
      if (!settled) {
        const uncertain = error instanceof ConversationDeliveryError ? error.uncertain : staged;
        this.drafts.fail(token, uncertain);
        try {
          await this.drafts.flush();
          if (!uncertain && staged && error instanceof ConversationDeliveryError) await this.messages.settleDraftDelivery(token.submissionId);
        } catch { /* Keep original envelopes when recovery persistence is not acknowledged. */ }
      }
      throw error;
    } finally { this.active.delete(token.submissionId); this.scheduleKnownReceipts(); }
  }
}
function tokenOf(owner: ChatDraftOwner, row: ChatDraftSubmission): DraftSubmissionToken {
  return { owner, submissionId: row.submissionId, editingRevision: row.nextEditingRevision, text: row.text, attachments: row.attachments };
}

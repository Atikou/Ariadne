import type { AriadneApi, InputDeliveryOutboxRecord, InputDeliveryOutboxStageRequest } from '@shared/contract';
import { shouldReconcileInput } from './input-delivery-outcome';
import type { RuntimeFeatureCommandGateway } from './runtime-feature-command-gateway';
import type { DraftDeliveryBinding } from './input-delivery-binding';

export class ConversationDeliveryError extends Error {
  constructor(readonly uncertain: boolean, readonly commandIds: readonly string[], readonly cause: unknown) {
    super(uncertain ? '消息结果尚未确认，请核对原发送。' : '消息未提交，请恢复原草稿。');
  }
}
/** Conversation input owner. Replay always comes from the sealed original
 * envelope, never from a draft's editable text or current session selection. */
export class ConversationInputDeliveryController {
  constructor(private readonly gateway: RuntimeFeatureCommandGateway, private readonly persistence?: AriadneApi['inputDeliveryOutbox']) {}
  async send(requests: readonly InputDeliveryOutboxStageRequest[], binding?: DraftDeliveryBinding): Promise<{ messageId: string; sessionId: string; sessionVersion: number }> {
    let records: InputDeliveryOutboxRecord[];
    try {
      if (binding && !this.persistence) throw new Error('input_delivery_persistence_required');
      records = this.persistence ? await this.persistence.stageBatch(requests)
        : requests.map(row => ({ ...row, createdAt: new Date().toISOString() }));
    } catch (error) { throw new ConversationDeliveryError(false, requests.map(row => row.commandId), error); }
    try {
      await binding?.onStaged(records.map(row => row.commandId));
      const accepted = await this.dispatch(records, binding);
      if (!binding) await this.settleRecords(records);
      return accepted;
    } catch (error) {
      if (error instanceof ConversationDeliveryError) {
        if (!error.uncertain && !binding) await this.settleRecords(records);
        throw error;
      }
      throw new ConversationDeliveryError(true, records.map(row => row.commandId), error);
    }
  }
  async reconcileDraft(submissionId: string, binding: DraftDeliveryBinding): Promise<{ messageId: string; sessionId: string; sessionVersion: number }> {
    if (!this.persistence || binding.submissionId !== submissionId) throw new Error('input_delivery_draft_identity_mismatch');
    const records = (await this.persistence.list()).filter(row => row.draftSubmissionId === submissionId && row.command.kind !== 'agent.inbox.enqueue');
    if (!records.some(row => row.command.kind === 'conversation.message.accept')) throw new Error('input_delivery_original_message_missing');
    await binding.onStaged(records.map(row => row.commandId));
    return this.dispatch(records, binding);
  }
  async settleDraft(submissionId: string): Promise<void> {
    if (!this.persistence) throw new Error('input_delivery_persistence_required');
    await this.settleRecords((await this.persistence.list()).filter(row => row.draftSubmissionId === submissionId && row.command.kind !== 'agent.inbox.enqueue'));
  }
  private async dispatch(records: readonly InputDeliveryOutboxRecord[], binding?: DraftDeliveryBinding): Promise<{ messageId: string; sessionId: string; sessionVersion: number }> {
    const creates = records.filter(row => row.command.kind === 'conversation.session.create');
    const messages = records.filter(row => row.command.kind === 'conversation.message.accept');
    if (creates.length > 1 || messages.length !== 1) throw new ConversationDeliveryError(true, records.map(row => row.commandId), new Error('input_delivery_batch_invalid'));
    const message = messages[0]!.command;
    if (message.kind !== 'conversation.message.accept') throw new Error('input_delivery_batch_invalid');
    if (creates.some(row => row.command.kind !== 'conversation.session.create' || row.command.sessionId !== message.sessionId || row.command.workspaceId !== message.workspaceId))
      throw new ConversationDeliveryError(true, records.map(row => row.commandId), new Error('input_delivery_batch_owner_mismatch'));
    for (const record of [...creates, ...messages]) {
      try {
        const result = await this.gateway.execute(record.command, record.commandId);
        if (record.command.kind === 'conversation.session.create') {
          if (result.kind !== 'conversation.session.created' || result.sessionId !== record.command.sessionId || result.version !== message.expectedSessionVersion)
            throw new Error('input_delivery_create_result_invalid');
          await binding?.onSessionCreated(result.sessionId);
        } else {
          if (result.kind !== 'conversation.message.accepted' || result.sessionId !== message.sessionId || result.messageId !== message.messageId)
            throw new Error('input_delivery_message_result_invalid');
          return { messageId: result.messageId, sessionId: result.sessionId, sessionVersion: result.sessionVersion };
        }
      } catch (error) {
        const unknown = shouldReconcileInput(error, record.commandId, true);
        throw new ConversationDeliveryError(unknown, records.map(row => row.commandId), error);
      }
    }
    throw new ConversationDeliveryError(true, records.map(row => row.commandId), new Error('input_delivery_message_result_missing'));
  }
  private async settleRecords(records: readonly InputDeliveryOutboxRecord[]): Promise<void> {
    for (const record of records) await this.persistence?.settle({ commandId: record.commandId });
  }
}

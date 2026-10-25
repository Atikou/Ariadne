import {
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  type RuntimeCommand
} from '@ariadne/protocol/public';
import type { AriadneApi } from '@shared/contract';
import {
  AgentInputDeliveryTracker,
  type AgentInputDeliveryReceipt,
  type VerifiedAgentInboxIdentity
} from '../agent-input-delivery';
import { shouldReconcileInput } from './input-delivery-outcome';
import type { RuntimeFeatureCommandGateway } from './runtime-feature-command-gateway';
import type { RunFeatureHost } from './run-feature-host';
import type { DraftDeliveryBinding } from './input-delivery-binding';
import { DraftLinkedDeliveryView } from './draft-linked-delivery-view';

export class AgentInputDeliveryController {
  private readonly tracker = new AgentInputDeliveryTracker();
  private persistenceReady: boolean;
  private persistenceErrorValue: string | null = null;
  private readonly draftLinks = new Map<string, string>();
  private readonly deliveryView = new DraftLinkedDeliveryView(this.draftLinks);

  constructor(
    private readonly gateway: RuntimeFeatureCommandGateway,
    private readonly host: RunFeatureHost,
    private readonly persistence?: AriadneApi['inputDeliveryOutbox']
  ) {
    this.persistenceReady = persistence === undefined;
  }

  snapshot(): AgentInputDeliveryReceipt[] {
    return this.deliveryView.read(this.tracker.snapshot());
  }

  get persistenceError(): string | null {
    return this.persistenceErrorValue;
  }

  observeInboxIdentities(identities: readonly VerifiedAgentInboxIdentity[]): void {
    for (const commandId of this.tracker.observeInboxIdentities(identities)) {
      if (this.draftLinks.has(commandId)) continue;
      void this.settlePersisted(commandId);
    }
  }

  async restorePersistence(generation: number): Promise<void> {
    if (this.persistence === undefined) return;
    try {
      const records = await this.persistence.list();
      if (!this.host.isLifecycleGenerationCurrent(generation)) return;
      const now = new Date().toISOString();
      for (const record of records) {
        if (record.command.kind !== 'agent.inbox.enqueue') continue;
        if (record.draftSubmissionId) this.deliveryView.link(record.commandId, record.draftSubmissionId);
        this.tracker.restore(record.commandId, record.command, record.createdAt, now);
      }
      this.persistenceReady = true;
      this.persistenceErrorValue = null;
      this.host.publish();
    } catch (error) {
      if (!this.host.isLifecycleGenerationCurrent(generation)) return;
      this.persistenceReady = false;
      this.persistenceErrorValue = this.host.errorMessage(
        error,
        '未结算输入的安全恢复记录不可用。'
      );
      this.host.publish();
    }
  }

  async enqueue(
    runId: string,
    sessionId: string,
    content: string,
    delivery: 'next_turn' | 'next_step',
    draft?: DraftDeliveryBinding
  ): Promise<AgentInputDeliveryReceipt> {
    const inputId = draft?.submissionId ?? crypto.randomUUID();
    const commandId = crypto.randomUUID();
    const command = {
      kind: 'agent.inbox.enqueue',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      runId,
      sessionId,
      inputId,
      delivery,
      content
    } satisfies Extract<RuntimeCommand, { kind: 'agent.inbox.enqueue' }>;
    if (!this.persistenceReady) {
      const receipt = this.tracker.begin(commandId, command, new Date().toISOString());
      const failed = this.tracker.fail(
        commandId,
        this.persistenceErrorValue ?? '无法安全保存待发送输入，输入未发送。',
        new Date().toISOString()
      );
      this.host.publish();
      return { ...receipt, ...failed };
    }
    try {
      if (draft && !this.persistence) throw new Error('input_delivery_persistence_required');
      const staged = await this.persistence?.stage({ commandId, command,
        ...(draft ? { draftSubmissionId: draft.submissionId } : {}) });
      if (draft) this.deliveryView.link(commandId, draft.submissionId);
      this.tracker.begin(commandId, command, staged?.createdAt ?? new Date().toISOString());
      await draft?.onStaged([commandId]);
    } catch (error) {
      if (this.draftLinks.has(commandId)) {
        const receipt = this.tracker.requireReconciliation(commandId, '发送身份已保存，草稿更新尚未完成；请核对原发送。', new Date().toISOString());
        this.host.publish(); return receipt;
      }
      this.tracker.begin(commandId, command, new Date().toISOString());
      const failed = this.tracker.fail(
        commandId,
        this.host.errorMessage(error, '无法安全保存待发送输入，输入未发送。'),
        new Date().toISOString()
      );
      this.host.publish();
      return failed;
    }
    this.host.publish();
    return this.dispatch(commandId, false);
  }

  async reconcile(commandId: string): Promise<AgentInputDeliveryReceipt> {
    const known = this.tracker.get(commandId);
    if (known?.state === 'accepted' || known?.state === 'failed') return known;
    this.tracker.beginReconciliation(commandId, new Date().toISOString());
    this.host.publish();
    return this.dispatch(commandId, true);
  }

  dismiss(commandId: string): void {
    this.tracker.dismiss(commandId);
    this.deliveryView.link(commandId);
    this.host.publish();
  }

  async settleDraftDelivery(commandId: string, submissionId: string): Promise<void> {
    if (this.draftLinks.get(commandId) !== submissionId) throw new Error('input_delivery_draft_identity_mismatch');
    const receipt = this.tracker.snapshot().find(row => row.commandId === commandId);
    if (!receipt || (receipt.state !== 'accepted' && receipt.state !== 'failed')) throw new Error('input_delivery_not_settled');
    if (!await this.settlePersisted(commandId)) throw new Error('input_delivery_settlement_persistence_failed');
  }

  private async dispatch(
    commandId: string,
    reconciliationAttempt: boolean
  ): Promise<AgentInputDeliveryReceipt> {
    const command = this.tracker.command(commandId);
    try {
      const result = await this.gateway.execute(command, commandId);
      if (result.kind !== 'agent.inbox.enqueued'
        || result.runId !== command.runId
        || result.inputId !== command.inputId) {
        throw new Error(`runtime_result_invalid:${result.kind}`);
      }
      const receipt = this.tracker.accept(commandId, new Date().toISOString());
      this.host.publish();
      if (!this.draftLinks.has(commandId)) void this.settlePersisted(commandId);
      void this.host.synchronize();
      return receipt;
    } catch (error) {
      const message = this.host.errorMessage(error, 'Agent 输入提交失败。');
      const reconciliationRequired = shouldReconcileInput(error, commandId, reconciliationAttempt);
      const persistenceSettled = reconciliationRequired ? false : this.draftLinks.has(commandId) || await this.settlePersisted(commandId);
      const receipt = reconciliationRequired || !persistenceSettled
        ? this.tracker.requireReconciliation(
            commandId,
            persistenceSettled ? message : `${message} 本地发送记录尚未安全结算，请重新确认。`,
            new Date().toISOString()
          )
        : this.tracker.fail(commandId, message, new Date().toISOString());
      this.host.publish();
      return receipt;
    }
  }

  private async settlePersisted(commandId: string): Promise<boolean> {
    if (this.persistence === undefined) return true;
    try {
      await this.persistence.settle({ commandId });
      this.persistenceErrorValue = null;
      return true;
    } catch (error) {
      this.persistenceErrorValue = this.host.errorMessage(
        error,
        '未结算输入的安全恢复记录无法更新。'
      );
      this.host.publish();
      return false;
    }
  }
}

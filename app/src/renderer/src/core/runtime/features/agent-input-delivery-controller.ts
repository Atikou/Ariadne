import {
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  type RuntimeCommand
} from '@ariadne/protocol/public';
import type { AriadneApi } from '@shared/contract';
import {
  AgentInputDeliveryTracker,
  type AgentInputDeliveryReceipt
} from '../agent-input-delivery';
import { PublicResultError } from '../public-result';
import type { RuntimeFeatureCommandGateway } from './runtime-feature-command-gateway';
import type { RunFeatureHost } from './run-feature-host';

export class AgentInputDeliveryController {
  private readonly tracker = new AgentInputDeliveryTracker();
  private persistenceReady: boolean;
  private persistenceErrorValue: string | null = null;

  constructor(
    private readonly gateway: RuntimeFeatureCommandGateway,
    private readonly host: RunFeatureHost,
    private readonly persistence?: AriadneApi['agentInputDeliveryOutbox']
  ) {
    this.persistenceReady = persistence === undefined;
  }

  snapshot(): AgentInputDeliveryReceipt[] {
    return this.tracker.snapshot();
  }

  get persistenceError(): string | null {
    return this.persistenceErrorValue;
  }

  observeProjection(): void {
    for (const commandId of this.tracker.observeProjection(this.host.projectionRuns())) {
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
    delivery: 'next_turn' | 'next_step'
  ): Promise<AgentInputDeliveryReceipt> {
    const inputId = crypto.randomUUID();
    const commandId = crypto.randomUUID();
    const command = {
      kind: 'agent.inbox.enqueue.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      runId,
      sessionId,
      inputId,
      delivery,
      content
    } satisfies Extract<RuntimeCommand, { kind: 'agent.inbox.enqueue.v3' }>;
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
      const staged = await this.persistence?.stage({ commandId, command });
      this.tracker.begin(commandId, command, staged?.createdAt ?? new Date().toISOString());
    } catch (error) {
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
    this.tracker.beginReconciliation(commandId, new Date().toISOString());
    this.host.publish();
    return this.dispatch(commandId, true);
  }

  dismiss(commandId: string): void {
    this.tracker.dismiss(commandId);
    this.host.publish();
  }

  private async dispatch(
    commandId: string,
    reconciliationAttempt: boolean
  ): Promise<AgentInputDeliveryReceipt> {
    const command = this.tracker.command(commandId);
    try {
      const result = await this.gateway.execute(command, commandId);
      if (result.kind !== 'agent.inbox.enqueued.v3'
        || result.runId !== command.runId
        || result.inputId !== command.inputId) {
        throw new Error(`runtime_result_invalid:${result.kind}`);
      }
      const receipt = this.tracker.accept(commandId, new Date().toISOString());
      this.host.publish();
      void this.settlePersisted(commandId);
      void this.host.synchronize();
      return receipt;
    } catch (error) {
      const message = this.host.errorMessage(error, 'Agent 输入提交失败。');
      const reconciliationRequired = shouldReconcile(error, commandId, reconciliationAttempt);
      const persistenceSettled = reconciliationRequired ? false : await this.settlePersisted(commandId);
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

const RECONCILABLE_CODES = new Set([
  'command_outcome_uncertain',
  'runtime_request_timeout',
  'runtime_request_cancelled',
  'runtime_request_send_failed'
]);

const DEFERRED_CODES = new Set([
  'runtime_unavailable',
  'runtime_initializing',
  'runtime_shutting_down',
  'runtime_stopped',
  'runtime_exited'
]);

function shouldReconcile(error: unknown, commandId: string, retry: boolean): boolean {
  if (!(error instanceof PublicResultError)) return false;
  const { code, correlationId } = error.publicError;
  if (correlationId === commandId && RECONCILABLE_CODES.has(code)) return true;
  return retry && DEFERRED_CODES.has(code);
}

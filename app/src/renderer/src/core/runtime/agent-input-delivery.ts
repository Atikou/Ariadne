import type {
  PublicRunProjectionV3,
  RuntimeCommand
} from '@ariadne/protocol/public';

type AgentInboxEnqueueCommand = Extract<
  RuntimeCommand,
  { readonly kind: 'agent.inbox.enqueue.v3' }
>;

export type AgentInputDeliveryState =
  | 'pending'
  | 'accepted'
  | 'reconcile'
  | 'failed';

export interface AgentInputDeliveryReceipt {
  readonly commandId: string;
  readonly inputId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly delivery: 'next_turn' | 'next_step';
  readonly content: string;
  readonly state: AgentInputDeliveryState;
  readonly attempt: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly error?: string;
}

interface TrackedAgentInputDelivery {
  readonly command: AgentInboxEnqueueCommand;
  readonly receipt: AgentInputDeliveryReceipt;
}

const MAX_TRACKED_AGENT_INPUT_DELIVERIES = 100;

/**
 * Bounded Renderer-only presentation state for durable Runtime commands.
 *
 * This is not another delivery authority. Runtime's command journal and Agent
 * inbox receipt own settlement. A matching Public Projection input settles the
 * local record as accepted because it is stronger evidence than any transport
 * response; the user may then dismiss that presentation receipt.
 */
export class AgentInputDeliveryTracker {
  private readonly records = new Map<string, TrackedAgentInputDelivery>();
  private cachedSnapshot: AgentInputDeliveryReceipt[] | undefined;

  begin(
    commandId: string,
    command: AgentInboxEnqueueCommand,
    now: string
  ): AgentInputDeliveryReceipt {
    if (this.records.has(commandId)) {
      throw new Error('agent_input_delivery_command_exists');
    }
    this.pruneSettledForCapacity();
    if (this.records.size >= MAX_TRACKED_AGENT_INPUT_DELIVERIES) {
      throw new Error('agent_input_delivery_capacity_exceeded');
    }
    const receipt: AgentInputDeliveryReceipt = {
      commandId,
      inputId: command.inputId,
      runId: command.runId,
      sessionId: command.sessionId,
      delivery: command.delivery,
      content: command.content,
      state: 'pending',
      attempt: 1,
      createdAt: now,
      updatedAt: now
    };
    this.cachedSnapshot = undefined;
    this.records.set(commandId, { command: { ...command }, receipt });
    return { ...receipt };
  }

  restore(
    commandId: string,
    command: AgentInboxEnqueueCommand,
    createdAt: string,
    now: string
  ): AgentInputDeliveryReceipt {
    const existing = this.records.get(commandId);
    if (existing !== undefined) {
      if (JSON.stringify(existing.command) !== JSON.stringify(command)) {
        throw new Error('agent_input_delivery_restore_conflict');
      }
      return { ...existing.receipt };
    }
    this.pruneSettledForCapacity();
    if (this.records.size >= MAX_TRACKED_AGENT_INPUT_DELIVERIES) {
      throw new Error('agent_input_delivery_capacity_exceeded');
    }
    const receipt: AgentInputDeliveryReceipt = {
      commandId,
      inputId: command.inputId,
      runId: command.runId,
      sessionId: command.sessionId,
      delivery: command.delivery,
      content: command.content,
      state: 'reconcile',
      attempt: 1,
      createdAt,
      updatedAt: now,
      error: '上次发送在界面退出前没有完成确认，请重新确认结果。'
    };
    this.cachedSnapshot = undefined;
    this.records.set(commandId, { command: { ...command }, receipt });
    return { ...receipt };
  }

  beginReconciliation(commandId: string, now: string): AgentInputDeliveryReceipt {
    const current = this.require(commandId);
    if (current.receipt.state !== 'reconcile') {
      throw new Error('agent_input_delivery_not_reconcilable');
    }
    const { error: _error, ...receipt } = current.receipt;
    return this.replace(commandId, {
      ...receipt,
      state: 'pending',
      attempt: current.receipt.attempt + 1,
      updatedAt: now
    });
  }

  accept(commandId: string, now: string): AgentInputDeliveryReceipt {
    const current = this.require(commandId);
    const { error: _error, ...receipt } = current.receipt;
    return this.replace(commandId, {
      ...receipt,
      state: 'accepted',
      updatedAt: now
    });
  }

  requireReconciliation(
    commandId: string,
    error: string,
    now: string
  ): AgentInputDeliveryReceipt {
    const current = this.require(commandId);
    return this.replace(commandId, {
      ...current.receipt,
      state: 'reconcile',
      updatedAt: now,
      error
    });
  }

  fail(commandId: string, error: string, now: string): AgentInputDeliveryReceipt {
    const current = this.require(commandId);
    return this.replace(commandId, {
      ...current.receipt,
      state: 'failed',
      updatedAt: now,
      error
    });
  }

  get(commandId: string): AgentInputDeliveryReceipt | null {
    const record = this.records.get(commandId);
    return record === undefined ? null : { ...record.receipt };
  }

  command(commandId: string): AgentInboxEnqueueCommand {
    return { ...this.require(commandId).command };
  }

  dismiss(commandId: string): void {
    const record = this.require(commandId);
    if (
      record.receipt.state === 'pending'
      || record.receipt.state === 'reconcile'
    ) {
      throw new Error('agent_input_delivery_unsettled');
    }
    this.cachedSnapshot = undefined;
    this.records.delete(commandId);
  }

  observeProjection(runs: readonly PublicRunProjectionV3[]): string[] {
    const authoritativeInputIds = new Set(runs.flatMap((run) => (
      run.inbox.map((input) => input.inputId)
    )));
    const acceptedCommandIds: string[] = [];
    for (const [commandId, record] of this.records) {
      if (
        !authoritativeInputIds.has(record.receipt.inputId)
        || record.receipt.state === 'accepted'
      ) continue;
      const { error: _error, ...receipt } = record.receipt;
      this.cachedSnapshot = undefined;
      this.records.set(commandId, {
        command: record.command,
        receipt: {
          ...receipt,
          state: 'accepted',
          updatedAt: new Date().toISOString()
        }
      });
      acceptedCommandIds.push(commandId);
    }
    return acceptedCommandIds;
  }

  snapshot(): AgentInputDeliveryReceipt[] {
    return this.cachedSnapshot ??= Object.freeze([...this.records.values()]
      .map(({ receipt }) => Object.freeze({ ...receipt }))
      .sort((left, right) => (
        left.createdAt.localeCompare(right.createdAt)
        || left.commandId.localeCompare(right.commandId)
      ))) as AgentInputDeliveryReceipt[];
  }

  private replace(
    commandId: string,
    receipt: AgentInputDeliveryReceipt
  ): AgentInputDeliveryReceipt {
    const current = this.require(commandId);
    this.cachedSnapshot = undefined;
    this.records.set(commandId, { command: current.command, receipt });
    return { ...receipt };
  }

  private require(commandId: string): TrackedAgentInputDelivery {
    const record = this.records.get(commandId);
    if (record === undefined) throw new Error('agent_input_delivery_missing');
    return record;
  }

  private pruneSettledForCapacity(): void {
    if (this.records.size < MAX_TRACKED_AGENT_INPUT_DELIVERIES) return;
    for (const [commandId, record] of this.records) {
      if (record.receipt.state === 'accepted' || record.receipt.state === 'failed') {
        this.cachedSnapshot = undefined;
        this.records.delete(commandId);
        if (this.records.size < MAX_TRACKED_AGENT_INPUT_DELIVERIES) return;
      }
    }
  }
}

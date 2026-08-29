import {
  AgentRunCommandService,
  isTerminalAgentRun,
  sha256AgentControlData
} from '@ariadne/agent-core';

import type { SqliteAgentRunUnitOfWork } from '../adapters/persistence/SqliteAgentRunUnitOfWork.js';
import type { RuntimeApplicationCommandResult } from '../ingress/RuntimeApplication.js';
import type { RuntimeCommandEnvelope } from '../ingress/RuntimeIngress.js';
import {
  completedPublicError,
  publicRunMutationFailure
} from './AgentPublicCommandFailures.js';

type AgentInboxCommand = Extract<
  RuntimeCommandEnvelope['command'],
  {
    readonly kind:
      | 'agent.inbox.enqueue.v3'
      | 'agent.inbox.replace.v3'
      | 'agent.inbox.remove.v3'
      | 'agent.subagent.send.v3';
  }
>;

interface AgentInboxMutationReceipt {
  readonly runId: string;
  readonly runVersion: number;
  readonly inputId: string;
  readonly inputVersion?: number;
}

export interface AgentInboxPublicCommandHandlerCallbacks {
  readonly wakeWorkScheduler: () => void;
  readonly wakeProjectionDrain: () => void;
}

/** Owns durable inbox mutation, replay, and public error translation. */
export class AgentInboxPublicCommandHandler {
  private readonly commands: AgentRunCommandService;

  public constructor(
    private readonly unitOfWork: SqliteAgentRunUnitOfWork,
    private readonly callbacks: AgentInboxPublicCommandHandlerCallbacks,
    private readonly now: () => Date = () => new Date()
  ) {
    this.commands = new AgentRunCommandService(unitOfWork);
  }

  public execute(
    envelope: RuntimeCommandEnvelope,
    command: AgentInboxCommand
  ): Promise<RuntimeApplicationCommandResult> {
    switch (command.kind) {
      case 'agent.inbox.enqueue.v3':
        return this.enqueue(envelope, command);
      case 'agent.inbox.replace.v3':
        return this.replace(envelope, command);
      case 'agent.inbox.remove.v3':
        return this.remove(envelope, command);
      case 'agent.subagent.send.v3':
        return this.sendToSubagent(envelope, command);
    }
  }

  private async enqueue(
    envelope: RuntimeCommandEnvelope,
    command: Extract<AgentInboxCommand, { readonly kind: 'agent.inbox.enqueue.v3' }>
  ): Promise<RuntimeApplicationCommandResult> {
    envelope.signal.throwIfAborted();
    const replayed = await this.loadCommittedMutation(
      envelope.commandId,
      command.runId,
      command.inputId,
      'inbox.input_enqueued'
    );
    if (replayed !== null) return completedInboxResult('enqueued', replayed);
    const run = await this.loadRun(command.runId);
    if (
      run === null
      || run.binding.sessionId !== command.sessionId
      || run.binding.objectiveRef.kind === 'parent_delegation'
      || isTerminalAgentRun(run)
    ) {
      return completedPublicError(
        envelope,
        'agent_inbox_target_unavailable',
        'The target Agent Run is no longer available for running input.',
        true
      );
    }
    const occurredAt = monotonicCommandTime(run.updatedAt, this.now());
    let result;
    try {
      result = await this.commands.execute({
        kind: 'run.enqueue_inbox_input',
        commandId: envelope.commandId,
        runId: run.runId,
        expectedVersion: run.version,
        occurredAt,
        input: {
          inputId: command.inputId,
          messageId: command.inputId,
          delivery: command.delivery,
          content: command.content,
          contentDigest: await sha256AgentControlData(command.content)
        }
      }, { turnInputPayloads: [], effectPayloads: [] });
    } catch (error) {
      const failure = publicRunMutationFailure(envelope, error);
      if (failure !== null) return failure;
      throw error;
    }
    this.callbacks.wakeWorkScheduler();
    this.callbacks.wakeProjectionDrain();
    return completedInboxResult('enqueued', {
      runId: result.run.runId,
      runVersion: result.run.version,
      inputId: command.inputId,
      inputVersion: 1
    });
  }

  private async sendToSubagent(
    envelope: RuntimeCommandEnvelope,
    command: Extract<AgentInboxCommand, { readonly kind: 'agent.subagent.send.v3' }>
  ): Promise<RuntimeApplicationCommandResult> {
    envelope.signal.throwIfAborted();
    const replayed = await this.loadCommittedMutation(
      envelope.commandId,
      command.childRunId,
      command.inputId,
      'inbox.input_enqueued'
    );
    if (replayed !== null) {
      return completedSubagentSendResult(command.parentRunId, replayed);
    }
    const authority = await this.unitOfWork.transaction(async (transaction) => ({
      parent: await transaction.loadRun(command.parentRunId),
      child: await transaction.loadRun(command.childRunId)
    }));
    const { parent, child } = authority;
    if (
      parent === null
      || child === null
      || isTerminalAgentRun(child)
      || parent.binding.sessionId !== command.sessionId
      || child.binding.sessionId !== command.sessionId
      || parent.state.status !== 'waiting_children'
      || child.binding.objectiveRef.kind !== 'parent_delegation'
      || child.binding.objectiveRef.parentRunId !== parent.runId
      || child.binding.objectiveRef.mode !== 'continuable'
    ) {
      return completedPublicError(
        envelope,
        'continuable_subagent_target_unavailable',
        'The direct continuable Child Run is not available for follow-up input.',
        true
      );
    }
    let result;
    try {
      result = await this.commands.execute({
        kind: 'run.enqueue_inbox_input',
        commandId: envelope.commandId,
        runId: child.runId,
        expectedVersion: child.version,
        occurredAt: monotonicCommandTime(child.updatedAt, this.now()),
        input: {
          inputId: command.inputId,
          messageId: command.inputId,
          delivery: 'next_turn',
          content: command.content,
          contentDigest: await sha256AgentControlData(command.content)
        }
      }, { turnInputPayloads: [], effectPayloads: [] });
    } catch (error) {
      const failure = publicRunMutationFailure(envelope, error);
      if (failure !== null) return failure;
      throw error;
    }
    this.callbacks.wakeWorkScheduler();
    this.callbacks.wakeProjectionDrain();
    return completedSubagentSendResult(parent.runId, {
      runId: result.run.runId,
      runVersion: result.run.version,
      inputId: command.inputId,
      inputVersion: 1
    });
  }

  private async replace(
    envelope: RuntimeCommandEnvelope,
    command: Extract<AgentInboxCommand, { readonly kind: 'agent.inbox.replace.v3' }>
  ): Promise<RuntimeApplicationCommandResult> {
    envelope.signal.throwIfAborted();
    const replayed = await this.loadCommittedMutation(
      envelope.commandId,
      command.runId,
      command.inputId,
      'inbox.input_replaced'
    );
    if (replayed !== null) return completedInboxResult('replaced', replayed);
    const run = await this.loadRun(command.runId);
    if (run === null || run.binding.objectiveRef.kind === 'parent_delegation') {
      return completedPublicError(
        envelope,
        'agent_inbox_target_unavailable',
        'The target Agent Run inbox is not available through the generic command.',
        true
      );
    }
    let result;
    try {
      result = await this.commands.execute({
        kind: 'run.replace_inbox_input',
        commandId: envelope.commandId,
        runId: run.runId,
        expectedVersion: run.version,
        occurredAt: monotonicCommandTime(run.updatedAt, this.now()),
        inputId: command.inputId,
        expectedInputVersion: command.expectedInputVersion,
        content: command.content,
        contentDigest: await sha256AgentControlData(command.content)
      }, { turnInputPayloads: [], effectPayloads: [] });
    } catch (error) {
      const failure = publicRunMutationFailure(envelope, error);
      if (failure !== null) return failure;
      throw error;
    }
    this.callbacks.wakeProjectionDrain();
    return completedInboxResult('replaced', {
      runId: result.run.runId,
      runVersion: result.run.version,
      inputId: command.inputId,
      inputVersion: command.expectedInputVersion + 1
    });
  }

  private async remove(
    envelope: RuntimeCommandEnvelope,
    command: Extract<AgentInboxCommand, { readonly kind: 'agent.inbox.remove.v3' }>
  ): Promise<RuntimeApplicationCommandResult> {
    envelope.signal.throwIfAborted();
    const replayed = await this.loadCommittedMutation(
      envelope.commandId,
      command.runId,
      command.inputId,
      'inbox.input_removed'
    );
    if (replayed !== null) return completedInboxResult('removed', replayed);
    const run = await this.loadRun(command.runId);
    if (run === null || run.binding.objectiveRef.kind === 'parent_delegation') {
      return completedPublicError(
        envelope,
        'agent_inbox_target_unavailable',
        'The target Agent Run inbox is not available through the generic command.',
        true
      );
    }
    let result;
    try {
      result = await this.commands.execute({
        kind: 'run.remove_inbox_input',
        commandId: envelope.commandId,
        runId: run.runId,
        expectedVersion: run.version,
        occurredAt: monotonicCommandTime(run.updatedAt, this.now()),
        inputId: command.inputId,
        expectedInputVersion: command.expectedInputVersion
      }, { turnInputPayloads: [], effectPayloads: [] });
    } catch (error) {
      const failure = publicRunMutationFailure(envelope, error);
      if (failure !== null) return failure;
      throw error;
    }
    this.callbacks.wakeProjectionDrain();
    return completedInboxResult('removed', {
      runId: result.run.runId,
      runVersion: result.run.version,
      inputId: command.inputId
    });
  }

  private loadRun(runId: string) {
    return this.unitOfWork.transaction((transaction) => transaction.loadRun(runId));
  }

  private async loadCommittedMutation(
    commandId: string,
    runId: string,
    inputId: string,
    eventType: 'inbox.input_enqueued' | 'inbox.input_replaced' | 'inbox.input_removed'
  ): Promise<AgentInboxMutationReceipt | null> {
    const receipt = await this.unitOfWork.loadCommittedCommandReceipt(commandId);
    if (receipt === null) return null;
    const mutation = receipt.mutations[0];
    const event = mutation?.events.find((candidate) => candidate.payload.type === eventType);
    if (
      receipt.mutations.length !== 1
      || mutation === undefined
      || mutation.runId !== runId
      || event === undefined
    ) throw new Error('agent_inbox_command_receipt_invalid');
    const payload = event.payload;
    let eventInputId: string;
    let inputVersion: number | undefined;
    if (payload.type === 'inbox.input_removed') {
      eventInputId = payload.inputId;
    } else if (
      payload.type === 'inbox.input_enqueued'
      || payload.type === 'inbox.input_replaced'
    ) {
      eventInputId = payload.input.inputId;
      inputVersion = payload.input.version;
    } else {
      throw new Error('agent_inbox_command_receipt_invalid');
    }
    if (eventInputId !== inputId) throw new Error('agent_inbox_command_receipt_invalid');
    return {
      runId,
      runVersion: mutation.run.version,
      inputId,
      ...(inputVersion === undefined ? {} : { inputVersion })
    };
  }
}

function monotonicCommandTime(updatedAt: string, now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error('agent_inbox_command_clock_invalid');
  return new Date(Math.max(now.getTime(), Date.parse(updatedAt))).toISOString();
}

function completedInboxResult(
  operation: 'enqueued' | 'replaced' | 'removed',
  receipt: AgentInboxMutationReceipt
): RuntimeApplicationCommandResult {
  const result = operation === 'removed'
    ? {
        kind: 'agent.inbox.removed.v3' as const,
        runId: receipt.runId,
        runVersion: receipt.runVersion,
        inputId: receipt.inputId
      }
    : operation === 'enqueued'
      ? {
          kind: 'agent.inbox.enqueued.v3' as const,
          runId: receipt.runId,
          runVersion: receipt.runVersion,
          inputId: receipt.inputId,
          inputVersion: 1 as const
        }
      : {
          kind: 'agent.inbox.replaced.v3' as const,
          runId: receipt.runId,
          runVersion: receipt.runVersion,
          inputId: receipt.inputId,
          inputVersion: receipt.inputVersion ?? 1
        };
  return { outcome: { ok: true, result }, settlement: 'completed' };
}

function completedSubagentSendResult(
  parentRunId: string,
  receipt: AgentInboxMutationReceipt
): RuntimeApplicationCommandResult {
  return {
    outcome: {
      ok: true,
      result: {
        kind: 'agent.subagent.input.sent.v3',
        parentRunId,
        childRunId: receipt.runId,
        childRunVersion: receipt.runVersion,
        inputId: receipt.inputId,
        inputVersion: 1
      }
    },
    settlement: 'completed'
  };
}

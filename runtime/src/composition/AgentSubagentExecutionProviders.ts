import {
  DEFAULT_AGENT_SUBAGENT_PROVIDER_ID,
  DEFAULT_AGENT_SUBAGENT_PROVIDER_BINDING,
  AgentRunVersionConflictError,
  assertValidAgentRun,
  type AgentInferenceAttempt,
  type AgentRun,
  type AgentRunUnitOfWork,
  type AgentSubagentMode,
  type AgentSubagentProviderBinding,
  type AgentSubagentProviderSelectionPolicy,
  type AgentTurn
} from '@ariadne/agent-core';
import { publicProjectionCanonicalIdSchema } from '@ariadne/protocol/public';

import { isOwnedAgentFollowUpInference } from '../control/execution/AgentFollowUpInferenceDispatchController.js';

import type {
  AgentRunWorkFollowUpOwner,
  AgentRunWorkFollowUpReceipt,
  AgentRunWorkFollowUpRequest
} from './AgentRunWorkScheduler.js';

export interface AgentSubagentExecutionProviderDescriptor {
  readonly providerId: string;
  readonly displayName: string;
  readonly configurationDigest: string;
  readonly transport: 'ordinary_run' | 'external_process';
  readonly supportedModes: readonly AgentSubagentMode[];
  readonly supportsStructuredReport: boolean;
  readonly inheritsParentContext: boolean;
  readonly usesParentTools: boolean;
}

export interface AgentSubagentExecutionProvider {
  readonly descriptor: AgentSubagentExecutionProviderDescriptor;
  dispatchDelegatedInitial(
    request: AgentRunWorkFollowUpRequest,
    signal: AbortSignal
  ): Promise<AgentRunWorkFollowUpReceipt>;
  dispatchFollowUp(
    request: AgentRunWorkFollowUpRequest,
    signal: AbortSignal
  ): Promise<AgentRunWorkFollowUpReceipt>;
}

export const ORDINARY_RUN_SUBAGENT_EXECUTION_PROVIDER_DESCRIPTOR:
AgentSubagentExecutionProviderDescriptor = Object.freeze({
  ...DEFAULT_AGENT_SUBAGENT_PROVIDER_BINDING
});

/** Frozen startup catalog used by Core before any Child identity is committed. */
export class ImmutableAgentSubagentExecutionProviderCatalog
implements AgentSubagentProviderSelectionPolicy {
  private readonly byId: ReadonlyMap<string, AgentSubagentExecutionProviderDescriptor>;

  public constructor(descriptors: readonly AgentSubagentExecutionProviderDescriptor[]) {
    const byId = new Map<string, AgentSubagentExecutionProviderDescriptor>();
    for (const descriptor of [...descriptors].sort((left, right) => (
      left.providerId.localeCompare(right.providerId)
    ))) {
      assertDescriptor(descriptor);
      if (byId.has(descriptor.providerId)) {
        throw new Error(`Duplicate SubAgent execution provider "${descriptor.providerId}".`);
      }
      byId.set(descriptor.providerId, Object.freeze({
        ...descriptor,
        supportedModes: Object.freeze(normalizedModes(descriptor.supportedModes))
      }));
    }
    if (!byId.has(DEFAULT_AGENT_SUBAGENT_PROVIDER_ID)) {
      throw new Error('The ordinary-run SubAgent execution provider is required.');
    }
    this.byId = byId;
  }

  public select(request: {
    readonly requestedProviderId: string | undefined;
    readonly mode: AgentSubagentMode;
    readonly parentRun: AgentRun;
  }): string | null {
    const providerId = request.requestedProviderId ?? DEFAULT_AGENT_SUBAGENT_PROVIDER_ID;
    const descriptor = this.byId.get(providerId);
    const pinned = pinnedProvider(request.parentRun, providerId);
    return descriptor !== undefined
      && pinned !== undefined
      && sameDescriptor(descriptor, pinned)
      && descriptor.supportedModes.includes(request.mode)
      ? providerId
      : null;
  }

  public list(): readonly AgentSubagentExecutionProviderDescriptor[] {
    return Object.freeze([...this.byId.values()].map((descriptor) => Object.freeze({
      ...descriptor,
      supportedModes: Object.freeze([...descriptor.supportedModes])
    })));
  }

  public isRestorable(binding: AgentRun['binding']): boolean {
    return pinnedProviders(binding).every((pinned) => {
      const current = this.byId.get(pinned.providerId);
      return current !== undefined && sameDescriptor(current, pinned);
    });
  }
}

/** Routes only after reloading the durable Child provider identity. */
export class AgentSubagentExecutionProviderRouter {
  private readonly providers: ReadonlyMap<string, AgentSubagentExecutionProvider>;

  public constructor(
    private readonly runs: AgentRunUnitOfWork,
    providers: readonly AgentSubagentExecutionProvider[]
  ) {
    const byId = new Map<string, AgentSubagentExecutionProvider>();
    for (const provider of providers) {
      assertDescriptor(provider.descriptor);
      if (byId.has(provider.descriptor.providerId)) {
        throw new Error(`Duplicate SubAgent execution provider "${provider.descriptor.providerId}".`);
      }
      byId.set(provider.descriptor.providerId, provider);
    }
    this.providers = byId;
  }

  public readonly delegatedInitial: AgentRunWorkFollowUpOwner = {
    dispatchOwned: (request, signal) => this.dispatch('initial', request, signal)
  };

  public readonly followUp: AgentRunWorkFollowUpOwner = {
    dispatchOwned: (request, signal) => this.dispatch('follow_up', request, signal)
  };

  private async dispatch(
    phase: 'initial' | 'follow_up',
    request: AgentRunWorkFollowUpRequest,
    signal: AbortSignal
  ): Promise<AgentRunWorkFollowUpReceipt> {
    signal.throwIfAborted();
    const run = await this.runs.transaction((transaction) => (
      transaction.loadRun(request.runId)
    ));
    if (run === null) throw new Error('SubAgent execution provider Run does not exist.');
    assertValidAgentRun(run);
    if (run.version !== request.expectedVersion) {
      throw new AgentRunVersionConflictError(
        run.runId,
        request.expectedVersion,
        run.version
      );
    }
    const objective = run.binding.objectiveRef;
    if (objective.kind !== 'parent_delegation') {
      throw new Error('SubAgent execution provider requires a delegated Child Run.');
    }
    const provider = this.providers.get(objective.providerId);
    const pinned = pinnedProvider(run, objective.providerId);
    if (
      provider === undefined
      || pinned === undefined
      || !sameDescriptor(provider.descriptor, pinned)
      || !provider.descriptor.supportedModes.includes(objective.mode)
    ) throw new Error('The durable SubAgent execution provider is unavailable.');
    const turn = exactRequestedTurn(run, request);
    assertProviderOwnsPhase(run, turn, request.attemptId, phase);
    signal.throwIfAborted();
    const receipt = phase === 'initial'
      ? provider.dispatchDelegatedInitial(request, signal)
      : provider.dispatchFollowUp(request, signal);
    const settled = await receipt;
    await this.assertDurableReceipt(request, settled);
    return settled;
  }

  private async assertDurableReceipt(
    request: AgentRunWorkFollowUpRequest,
    receipt: AgentRunWorkFollowUpReceipt
  ): Promise<void> {
    const result = receipt.result;
    if (receipt.status === 'completed') {
      const completedResult = receipt.result;
      if (
        completedResult.status !== receipt.inferenceStatus
        || completedResult.attempt.state?.status !== receipt.inferenceStatus
      ) throw new Error('SubAgent execution provider returned a contradictory terminal receipt.');
    }
    if (
      receipt.status === 'waiting_recovery'
      && receipt.reason === 'inference_outcome_uncertain'
      && (
        result === undefined
        || result.status !== 'uncertain'
        || result.attempt.state?.status !== 'uncertain'
      )
    ) throw new Error('SubAgent execution provider omitted uncertain inference evidence.');

    const committed = await this.runs.transaction((transaction) => (
      transaction.loadRun(request.runId)
    ));
    if (committed === null) {
      throw new Error('SubAgent execution provider removed its durable Child Run.');
    }
    assertValidAgentRun(committed);
    const committedTurn = committed.turns.find(
      (candidate) => candidate.turnId === request.turnId
    );
    const committedAttempt = committedTurn?.attempts.find(
      (candidate) => candidate.attemptId === request.attemptId
    );
    if (
      committed.version <= request.expectedVersion
      || committedAttempt === undefined
      || committedAttempt.state.status === 'intended'
      || (
        result !== undefined
        && (
          result.run.runId !== committed.runId
          || result.run.version > committed.version
          || result.turn.turnId !== committedTurn?.turnId
          || result.attempt.attemptId !== committedAttempt.attemptId
          || result.attempt.state?.status !== committedAttempt.state.status
        )
      )
    ) throw new Error('SubAgent execution provider receipt has no matching durable Attempt.');
  }
}

export function ordinaryRunSubagentExecutionProvider(
  delegatedInitial: AgentRunWorkFollowUpOwner,
  followUp: AgentRunWorkFollowUpOwner
): AgentSubagentExecutionProvider {
  return {
    descriptor: {
      ...ORDINARY_RUN_SUBAGENT_EXECUTION_PROVIDER_DESCRIPTOR,
      supportedModes: [...ORDINARY_RUN_SUBAGENT_EXECUTION_PROVIDER_DESCRIPTOR.supportedModes]
    },
    dispatchDelegatedInitial: (request, signal) => (
      delegatedInitial.dispatchOwned(request, signal)
    ),
    dispatchFollowUp: (request, signal) => followUp.dispatchOwned(request, signal)
  };
}

function assertDescriptor(descriptor: AgentSubagentExecutionProviderDescriptor): void {
  if (
    !publicProjectionCanonicalIdSchema.safeParse(descriptor.providerId).success
    || descriptor.displayName.length === 0
    || descriptor.displayName.trim() !== descriptor.displayName
    || descriptor.displayName.length > 256
    || !/^sha256:[a-f0-9]{64}$/u.test(descriptor.configurationDigest)
    || (descriptor.transport !== 'ordinary_run' && descriptor.transport !== 'external_process')
    || descriptor.supportedModes.length === 0
    || new Set(descriptor.supportedModes).size !== descriptor.supportedModes.length
    || descriptor.supportedModes.some((mode) => mode !== 'one_shot' && mode !== 'continuable')
    || typeof descriptor.supportsStructuredReport !== 'boolean'
    || typeof descriptor.inheritsParentContext !== 'boolean'
    || typeof descriptor.usesParentTools !== 'boolean'
  ) throw new Error('SubAgent execution provider descriptor is invalid.');
}

function pinnedProvider(
  run: AgentRun,
  providerId: string
): AgentSubagentProviderBinding | undefined {
  return pinnedProviders(run.binding).find(
    (provider) => provider.providerId === providerId
  );
}

function pinnedProviders(
  binding: AgentRun['binding']
): readonly AgentSubagentProviderBinding[] {
  const providers = binding.bindingVersion === 4
    ? binding.executionProfile.subagentProviders
    : undefined;
  return providers ?? [ORDINARY_RUN_SUBAGENT_EXECUTION_PROVIDER_DESCRIPTOR];
}

function sameDescriptor(
  left: AgentSubagentExecutionProviderDescriptor,
  right: AgentSubagentProviderBinding
): boolean {
  return left.providerId === right.providerId
    && left.displayName === right.displayName
    && left.configurationDigest === right.configurationDigest
    && left.transport === right.transport
    && left.supportsStructuredReport === right.supportsStructuredReport
    && left.inheritsParentContext === right.inheritsParentContext
    && left.usesParentTools === right.usesParentTools
    && normalizedModes(left.supportedModes).join('\u0000')
      === normalizedModes(right.supportedModes).join('\u0000');
}

function normalizedModes(modes: readonly AgentSubagentMode[]): AgentSubagentMode[] {
  return [...modes].sort((left, right) => modeOrder(left) - modeOrder(right));
}

function modeOrder(mode: AgentSubagentMode): number {
  return mode === 'one_shot' ? 0 : 1;
}

function exactRequestedTurn(
  run: AgentRun,
  request: AgentRunWorkFollowUpRequest
): AgentTurn {
  const turn = run.turns.find((candidate) => candidate.turnId === request.turnId);
  const attempt = turn?.attempts.find(
    (candidate) => candidate.attemptId === request.attemptId
  );
  if (
    run.state.status !== 'running'
    || turn === undefined
    || attempt === undefined
    || attempt.state.status !== 'intended'
  ) throw new Error('SubAgent execution provider requires the exact intended Attempt.');
  return turn;
}

function assertProviderOwnsPhase(
  run: AgentRun,
  turn: AgentTurn,
  attemptId: string,
  phase: 'initial' | 'follow_up'
): void {
  const attempt = turn.attempts.find((candidate): candidate is AgentInferenceAttempt => (
    candidate.attemptId === attemptId
  ));
  if (attempt?.state.status !== 'intended') {
    throw new Error('SubAgent execution provider Attempt is not intended.');
  }
  const cause = turn.intention.cause;
  if (phase === 'initial') {
    const objective = run.binding.objectiveRef;
    if (
      objective.kind !== 'parent_delegation'
      || run.turns.length !== 1
      || turn !== run.turns[0]
      || turn.attempts.length !== 1
      || attempt.cause.kind !== 'initial'
      || cause.kind !== 'delegation_objective'
      || cause.parentRunId !== objective.parentRunId
      || cause.delegationId !== objective.delegationId
      || cause.objectiveDigest !== objective.objectiveDigest
    ) throw new Error('SubAgent execution provider cannot own this initial Turn.');
    return;
  }
  if (!isOwnedAgentFollowUpInference(run, turn, attempt)) {
    throw new Error('SubAgent execution provider cannot own this follow-up Turn.');
  }
}

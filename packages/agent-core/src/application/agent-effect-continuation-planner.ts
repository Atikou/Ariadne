import {
  assertValidAgentRun,
  type AgentRun
} from '../domain/agent-run.js';
import { AgentRunInvariantError } from '../domain/errors.js';
import type {
  AgentCommittedDirective,
  AgentCommittedToolInvocation
} from '../domain/directive.js';
import type { AgentInferenceAttempt, AgentTurnCause } from '../domain/turn.js';
import type { RegisterAgentTurnCommand } from './commands.js';
import type {
  AgentTurnInputMessage,
  AgentTurnInputModelData
} from './agent-engine.js';
import {
  assertAgentRunCommitArtifactDigests,
  assertAgentTurnInputSnapshotMatchesTurn,
  assertSanitizedAgentEffectCancellationReason,
  createAgentEffectCancellationResult,
  type AgentRunCheckpointCommit,
  type AgentRunCommitArtifacts,
  type AgentTerminalEffectResultEvidence,
  type AgentTurnInputPayloadCommit,
  type AgentTurnInputSnapshotV1
} from './recovery-persistence.js';
import { deriveStableAgentId } from './stable-id.js';
import { transitionAgentRun } from './transition-agent-run.js';
import {
  canonicalizeAgentTurnInput,
  digestAgentTurnInput,
  summarizeAgentTurnInput
} from './turn-input-digest.js';

export interface PlanAgentEffectContinuationRequest {
  /** Current aggregate loaded in the same authority/UoW boundary as the evidence. */
  readonly run: AgentRun;
  /** Exact protected snapshot belonging to the source Turn. */
  readonly sourceTurnInput: AgentTurnInputSnapshotV1;
  /** Exact source batch in committed invocation order. */
  readonly effectResults: readonly AgentTerminalEffectResultEvidence[];
}

export interface AgentEffectContinuationPlan {
  readonly command: RegisterAgentTurnCommand;
  readonly checkpoint: AgentRunCheckpointCommit;
  readonly turnInput: AgentTurnInputSnapshotV1;
  readonly turnInputCommit: AgentTurnInputPayloadCommit;
  readonly artifacts: AgentRunCommitArtifacts;
}

/** Pure, deterministic continuation planning; it performs no persistence or I/O. */
export interface AgentEffectContinuationPlanner {
  plan(request: PlanAgentEffectContinuationRequest): Promise<AgentEffectContinuationPlan>;
}

type SucceededToolAttempt = AgentInferenceAttempt & {
  readonly state: Extract<
    AgentInferenceAttempt['state'],
    { readonly status: 'succeeded' }
  > & {
    readonly directive: Extract<
      AgentCommittedDirective,
      { readonly kind: 'invoke_tools' }
    >;
  };
};

export class DefaultAgentEffectContinuationPlanner
implements AgentEffectContinuationPlanner {
  public async plan(
    request: PlanAgentEffectContinuationRequest
  ): Promise<AgentEffectContinuationPlan> {
    assertExactRequest(request);
    assertValidAgentRun(request.run);
    const run = request.run;
    if (run.state.status !== 'running') {
      throw new AgentRunInvariantError(
        'Effect continuation requires an authoritative running AgentRun.'
      );
    }
    if (Date.parse(run.updatedAt) >= Date.parse(run.binding.budget.deadlineAt)) {
      throw new AgentRunInvariantError(
        'Effect continuation cannot cross the immutable Run deadline.'
      );
    }
    if (run.turns.length >= run.binding.budget.vector.modelTurns) {
      throw new AgentRunInvariantError(
        'Effect continuation exceeds the immutable Run model-turn budget.'
      );
    }

    const sourceTurn = run.turns.at(-1);
    if (
      sourceTurn === undefined
      || sourceTurn.turnId !== request.sourceTurnInput.turnId
    ) {
      throw new AgentRunInvariantError(
        'Effect continuation must extend the authoritative latest Turn snapshot.'
      );
    }
    await assertAgentTurnInputSnapshotMatchesTurn(
      run,
      sourceTurn.turnId,
      sourceTurn.intention.inputDigest,
      request.sourceTurnInput
    );
    const sourceAttempt = requireSucceededToolAttempt(sourceTurn.attempts.at(-1));
    const directive = sourceAttempt.state.directive;
    const cause: Extract<AgentTurnCause, { readonly kind: 'effect_results' }> = {
      kind: 'effect_results',
      sourceTurnId: sourceTurn.turnId,
      sourceAttemptId: sourceAttempt.attemptId,
      sourceDirectiveDigest: sourceAttempt.state.directiveDigest,
      effectIds: directive.invocations.map((invocation) => invocation.effectId),
      toolCallIds: directive.invocations.map((invocation) => invocation.toolCallId)
    };
    const appended = exactCurrentResultMessages(run, directive.invocations, request.effectResults);
    const modelData = canonicalModelData({
      messages: [...request.sourceTurnInput.messages, ...appended],
      availableTools: request.sourceTurnInput.availableTools
    });
    const inputDigest = await digestAgentTurnInput(modelData);
    const inputSummary = summarizeAgentTurnInput(modelData);

    const identity = [
      run.runId,
      sourceTurn.turnId,
      sourceAttempt.attemptId,
      sourceAttempt.state.directiveDigest
    ] as const;
    const commandId = await deriveStableAgentId('effect-continuation', ...identity);
    const turnId = await deriveStableAgentId('continuation-turn', ...identity);
    const attemptId = await deriveStableAgentId('continuation-attempt', ...identity);
    const providerIdempotencyKey = await deriveStableAgentId(
      'continuation-provider',
      ...identity
    );
    const occurredAt = run.updatedAt;
    const command: RegisterAgentTurnCommand = {
      kind: 'run.register_turn',
      commandId,
      runId: run.runId,
      expectedVersion: run.version,
      occurredAt,
      turn: {
        cause,
        turnId,
        attemptId,
        providerIdempotencyKey,
        inputDigest,
        inputSummary
      }
    };
    const turnInput: AgentTurnInputSnapshotV1 = {
      format: 'ariadne.agent-turn-input',
      schemaVersion: 1,
      runId: run.runId,
      turnId,
      cause: {
        ...cause,
        effectIds: [...cause.effectIds],
        toolCallIds: [...cause.toolCallIds]
      },
      authorityRef: cloneAuthorityReference(request.sourceTurnInput.authorityRef),
      messages: modelData.messages,
      availableTools: modelData.availableTools
    };
    const checkpoint: AgentRunCheckpointCommit = {
      checkpointVersion: run.state.checkpointVersion + 1,
      createdAt: occurredAt,
      payload: {
        format: 'ariadne.agent-checkpoint',
        schemaVersion: 1,
        engineContinuation: {
          phase: 'effect_results_ready',
          sourceTurnId: sourceTurn.turnId,
          sourceAttemptId: sourceAttempt.attemptId,
          sourceDirectiveDigest: sourceAttempt.state.directiveDigest,
          continuationTurnId: turnId,
          continuationAttemptId: attemptId
        },
        modelContext: null
      }
    };
    const turnInputCommit: AgentTurnInputPayloadCommit = {
      turnId,
      inputDigest,
      payload: turnInput,
      recordedAt: occurredAt
    };
    const artifacts: AgentRunCommitArtifacts = {
      checkpoint,
      turnInputPayloads: [turnInputCommit],
      effectPayloads: []
    };

    // Exercise the same aggregate and artifact invariants as the write path so
    // a plan cannot be produced for partial, duplicated, or drifted state.
    const transition = transitionAgentRun(run, command);
    await assertAgentRunCommitArtifactDigests(run, transition.run, artifacts);
    return { command, checkpoint, turnInput, turnInputCommit, artifacts };
  }
}

function requireSucceededToolAttempt(
  attempt: AgentInferenceAttempt | undefined
): SucceededToolAttempt {
  if (
    attempt?.state.status !== 'succeeded'
    || attempt.state.directive.kind !== 'invoke_tools'
  ) {
    throw new AgentRunInvariantError(
      'Effect continuation requires the latest Attempt to have one succeeded invoke_tools Directive.'
    );
  }
  return attempt as SucceededToolAttempt;
}

function exactCurrentResultMessages(
  run: AgentRun,
  invocations: readonly AgentCommittedToolInvocation[],
  evidence: readonly AgentTerminalEffectResultEvidence[]
): readonly Extract<AgentTurnInputMessage, { readonly kind: 'effect_result' }>[] {
  if (!Array.isArray(evidence) || evidence.length !== invocations.length) {
    throw new AgentRunInvariantError(
      'Effect continuation requires the complete protected result batch.'
    );
  }
  const sourceEffectIds = new Set(invocations.map((invocation) => invocation.effectId));
  const originated = run.effects.filter((effect) => sourceEffectIds.has(effect.effectId));
  if (originated.length !== invocations.length) {
    throw new AgentRunInvariantError(
      'Effect continuation cannot proceed from a partial or expanded Effect batch.'
    );
  }
  const seenEffectIds = new Set<string>();
  const seenToolCallIds = new Set<string>();
  return invocations.map((invocation, index) => {
    const proof = evidence[index];
    const effect = run.effects.find((candidate) => candidate.effectId === invocation.effectId);
    if (
      proof === undefined
      || effect === undefined
      || seenEffectIds.has(proof.effectId)
      || seenToolCallIds.has(proof.toolCallId)
      || proof.runId !== run.runId
      || proof.effectId !== invocation.effectId
      || proof.toolCallId !== invocation.toolCallId
      || proof.inputDigest !== effect.inputDigest
      || proof.effectId !== effect.effectId
      || proof.toolCallId !== effect.toolCallId
      || proof.status !== effect.state.status
    ) {
      throw new AgentRunInvariantError(
        'Effect continuation evidence drifted from committed invocation order or aggregate state.'
      );
    }
    seenEffectIds.add(proof.effectId);
    seenToolCallIds.add(proof.toolCallId);
    if (proof.kind === 'protected_result') {
      if (
        !isExactDataObject(proof, [
          'kind',
          'runId',
          'effectId',
          'toolCallId',
          'inputDigest',
          'status',
          'result'
        ])
        || (proof.status !== 'succeeded' && proof.status !== 'failed')
      ) {
        throw new AgentRunInvariantError(
          'Known Effect outcomes require one exact protected result body.'
        );
      }
      return {
        kind: 'effect_result',
        effectId: effect.effectId,
        toolCallId: effect.toolCallId,
        status: proof.status,
        result: proof.result
      };
    }
    if (
      proof.kind !== 'aggregate_cancelled'
      || !isExactDataObject(proof, [
        'kind',
        'runId',
        'effectId',
        'toolCallId',
        'inputDigest',
        'status',
        'reason'
      ])
      || proof.status !== 'cancelled'
      || effect.state.status !== 'cancelled'
      || proof.reason !== effect.state.reason
    ) {
      throw new AgentRunInvariantError(
        'Cancelled Effect outcomes require their exact aggregate reason.'
      );
    }
    assertSanitizedAgentEffectCancellationReason(proof.reason);
    return {
      kind: 'effect_result',
      effectId: effect.effectId,
      toolCallId: effect.toolCallId,
      status: 'cancelled',
      result: createAgentEffectCancellationResult(proof.reason)
    };
  });
}

function canonicalModelData(input: AgentTurnInputModelData): AgentTurnInputModelData {
  const canonical = canonicalizeAgentTurnInput(input);
  return JSON.parse(canonical) as AgentTurnInputModelData;
}

function cloneAuthorityReference(
  authority: AgentTurnInputSnapshotV1['authorityRef']
): AgentTurnInputSnapshotV1['authorityRef'] {
  return authority.kind === 'conversation_message'
    ? { ...authority }
    : { ...authority };
}

function assertExactRequest(request: PlanAgentEffectContinuationRequest): void {
  if (!isExactDataObject(request, ['run', 'sourceTurnInput', 'effectResults'])) {
    throw new AgentRunInvariantError(
      'Effect continuation planning requires its exact authoritative inputs.'
    );
  }
}

function isExactDataObject(value: unknown, keys: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length
    && ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor;
    });
}

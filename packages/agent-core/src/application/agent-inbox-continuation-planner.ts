import { assertValidAgentRun, type AgentRun } from '../domain/agent-run.js';
import { AgentRunInvariantError } from '../domain/errors.js';
import type { AgentInboxInput } from '../domain/inbox.js';
import type { AgentTurnCause } from '../domain/turn.js';
import type { RegisterAgentTurnCommand } from './commands.js';
import {
  assertAgentRunCommitArtifactDigests,
  assertAgentTurnInputSnapshotMatchesTurn,
  type AgentRunCheckpointCommit,
  type AgentRunCommitArtifacts,
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
import type { AgentTurnInputModelData } from './agent-engine.js';

export interface PlanAgentInboxContinuationRequest {
  readonly run: AgentRun;
  readonly sourceTurnInput: AgentTurnInputSnapshotV1;
  readonly boundary:
    | {
        readonly kind: 'settled_response';
        readonly assistantContent: string;
      }
    | {
        readonly kind: 'interrupted_inference';
        readonly interruptionNotice: string;
      };
  readonly inputIds: readonly string[];
}

export interface AgentInboxContinuationPlan {
  readonly command: RegisterAgentTurnCommand;
  readonly artifacts: AgentRunCommitArtifacts;
}

/** Builds the exact next model Turn from one settled response and claimed inbox inputs. */
export class DefaultAgentInboxContinuationPlanner {
  public async plan(
    request: PlanAgentInboxContinuationRequest
  ): Promise<AgentInboxContinuationPlan> {
    assertValidAgentRun(request.run);
    const run = request.run;
    if (
      (run.state.status !== 'running' && run.state.status !== 'waiting_input')
      || request.inputIds.length === 0
    ) throw invalid('Agent inbox continuation request is not at a response boundary.');
    if (
      run.turns.length >= run.binding.budget.vector.modelTurns
      || Date.parse(run.updatedAt) >= Date.parse(run.binding.budget.deadlineAt)
    ) throw invalid('Agent inbox continuation exceeds its immutable Run budget.');

    const sourceTurn = run.turns.at(-1);
    const sourceAttempt = sourceTurn?.attempts.at(-1);
    if (sourceTurn === undefined || sourceAttempt === undefined) {
      throw invalid('Agent inbox continuation requires a source inference boundary.');
    }
    if (request.boundary.kind === 'settled_response') {
      if (
        request.boundary.assistantContent.length === 0
        || request.boundary.assistantContent.length > 1_048_576
        || sourceAttempt.state.status !== 'succeeded'
        || (sourceAttempt.state.directive.kind !== 'respond'
          && sourceAttempt.state.directive.kind !== 'complete'
          && sourceAttempt.state.directive.kind !== 'ask_user')
      ) throw invalid('Agent inbox continuation requires the latest succeeded response.');
    } else if (
      request.boundary.interruptionNotice.length === 0
      || request.boundary.interruptionNotice.length > 1_048_576
      || run.state.status !== 'waiting_input'
      || !('recoveryDecisionId' in run.state)
      || run.state.interruptedTurnId !== sourceTurn.turnId
      || run.state.interruptedAttemptId !== sourceAttempt.attemptId
      || sourceAttempt.state.status !== 'uncertain'
      || sourceAttempt.state.recovery.decisionId !== run.state.recoveryDecisionId
    ) {
      throw invalid('Agent inbox continuation requires the exact interrupted inference.');
    }
    await assertAgentTurnInputSnapshotMatchesTurn(
      run,
      sourceTurn.turnId,
      sourceTurn.intention.inputDigest,
      request.sourceTurnInput
    );
    const queued = run.inbox.filter((input) => input.state === 'queued');
    const nextTurn = queued.find((input) => input.delivery === 'next_turn');
    const inputs = queued.filter((input) => (
      input.delivery === 'next_step'
      || input.inputId === nextTurn?.inputId
    ));
    if (
      inputs.length !== request.inputIds.length
      || inputs.some((input, index) => input.inputId !== request.inputIds[index])
    ) throw invalid('Agent inbox inputs differ from the exact response-boundary claim.');

    const cause: Extract<
      AgentTurnCause,
      { readonly kind: 'inbox_inputs' | 'interrupted_inference' }
    > = request.boundary.kind === 'settled_response'
      ? {
          kind: 'inbox_inputs',
          sourceTurnId: sourceTurn.turnId,
          sourceAttemptId: sourceAttempt.attemptId,
          sourceDirectiveDigest: requireSettledDirectiveDigest(sourceAttempt),
          inputIds: [...request.inputIds]
        }
      : {
          kind: 'interrupted_inference',
          sourceTurnId: sourceTurn.turnId,
          sourceAttemptId: sourceAttempt.attemptId,
          recoveryDecisionId: requireInterruptedRecoveryDecisionId(run),
          inputIds: [...request.inputIds]
        };
    const modelData = canonicalModelData({
      messages: [
        ...request.sourceTurnInput.messages,
        request.boundary.kind === 'settled_response'
          ? {
              kind: 'text' as const,
              role: 'assistant' as const,
              content: request.boundary.assistantContent
            }
          : {
              kind: 'text' as const,
              role: 'system' as const,
              content: request.boundary.interruptionNotice
            },
        ...inputs.map((input) => ({
          kind: 'text' as const,
          role: inboxRole(input),
          content: input.content
        }))
      ],
      availableTools: request.sourceTurnInput.availableTools
    });
    const inputDigest = await digestAgentTurnInput(modelData);
    const inputSummary = summarizeAgentTurnInput(modelData);
    const identity = [
      run.runId,
      sourceTurn.turnId,
      sourceAttempt.attemptId,
      cause.kind === 'inbox_inputs'
        ? cause.sourceDirectiveDigest
        : cause.recoveryDecisionId,
      ...inputs.flatMap((input) => [input.inputId, input.contentDigest])
    ] as const;
    const commandId = await deriveStableAgentId('inbox-continuation', ...identity);
    const turnId = await deriveStableAgentId('inbox-continuation-turn', ...identity);
    const attemptId = await deriveStableAgentId('inbox-continuation-attempt', ...identity);
    const providerIdempotencyKey = await deriveStableAgentId(
      'inbox-continuation-provider',
      ...identity
    );
    const command: RegisterAgentTurnCommand = {
      kind: 'run.register_turn',
      commandId,
      runId: run.runId,
      expectedVersion: run.version,
      occurredAt: run.updatedAt,
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
      cause: { ...cause, inputIds: [...cause.inputIds] },
      authorityRef: { ...request.sourceTurnInput.authorityRef },
      messages: modelData.messages,
      availableTools: modelData.availableTools
    };
    const checkpoint: AgentRunCheckpointCommit = {
      checkpointVersion: run.state.checkpointVersion + 1,
      createdAt: run.updatedAt,
      payload: {
        format: 'ariadne.agent-checkpoint',
        schemaVersion: 1,
        engineContinuation: {
          phase: cause.kind === 'inbox_inputs'
            ? 'inbox_inputs_ready'
            : 'interrupted_inference_inputs_ready',
          sourceTurnId: sourceTurn.turnId,
          sourceAttemptId: sourceAttempt.attemptId,
          ...(cause.kind === 'inbox_inputs'
            ? { sourceDirectiveDigest: cause.sourceDirectiveDigest }
            : { recoveryDecisionId: cause.recoveryDecisionId }),
          inputIds: [...cause.inputIds],
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
      recordedAt: run.updatedAt
    };
    const artifacts: AgentRunCommitArtifacts = {
      checkpoint,
      turnInputPayloads: [turnInputCommit],
      effectPayloads: []
    };
    const transition = transitionAgentRun(run, command);
    await assertAgentRunCommitArtifactDigests(run, transition.run, artifacts);
    return { command, artifacts };
  }
}

function canonicalModelData(input: AgentTurnInputModelData): AgentTurnInputModelData {
  return JSON.parse(canonicalizeAgentTurnInput(input)) as AgentTurnInputModelData;
}

function requireSettledDirectiveDigest(
  attempt: AgentRun['turns'][number]['attempts'][number]
): string {
  if (attempt.state.status !== 'succeeded') {
    throw invalid('Settled response Directive digest is unavailable.');
  }
  return attempt.state.directiveDigest;
}

function requireInterruptedRecoveryDecisionId(run: AgentRun): string {
  if (run.state.status !== 'waiting_input' || !('recoveryDecisionId' in run.state)) {
    throw invalid('Interrupted inference recovery identity is unavailable.');
  }
  return run.state.recoveryDecisionId;
}

function inboxRole(input: AgentInboxInput): 'user' | 'system' {
  return input.source?.kind === 'live_work' ? 'system' : 'user';
}

function invalid(message: string): AgentRunInvariantError {
  return new AgentRunInvariantError(message);
}

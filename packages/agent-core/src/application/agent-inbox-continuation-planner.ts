import { assertValidAgentRun, type AgentRun } from '../domain/agent-run.js';
import { AgentRunInvariantError } from '../domain/errors.js';
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
  readonly assistantContent: string;
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
      run.state.status !== 'running'
      || request.assistantContent.length === 0
      || request.assistantContent.length > 1_048_576
      || request.inputIds.length === 0
    ) throw invalid('Agent inbox continuation request is not at a response boundary.');
    if (
      run.turns.length >= run.binding.budget.vector.modelTurns
      || Date.parse(run.updatedAt) >= Date.parse(run.binding.budget.deadlineAt)
    ) throw invalid('Agent inbox continuation exceeds its immutable Run budget.');

    const sourceTurn = run.turns.at(-1);
    const sourceAttempt = sourceTurn?.attempts.at(-1);
    if (
      sourceTurn === undefined
      || sourceAttempt?.state.status !== 'succeeded'
      || (sourceAttempt.state.directive.kind !== 'respond'
        && sourceAttempt.state.directive.kind !== 'complete')
    ) throw invalid('Agent inbox continuation requires the latest succeeded response.');
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

    const cause: Extract<AgentTurnCause, { readonly kind: 'inbox_inputs' }> = {
      kind: 'inbox_inputs',
      sourceTurnId: sourceTurn.turnId,
      sourceAttemptId: sourceAttempt.attemptId,
      sourceDirectiveDigest: sourceAttempt.state.directiveDigest,
      inputIds: [...request.inputIds]
    };
    const modelData = canonicalModelData({
      messages: [
        ...request.sourceTurnInput.messages,
        { kind: 'text', role: 'assistant', content: request.assistantContent },
        ...inputs.map((input) => ({
          kind: 'text' as const,
          role: 'user' as const,
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
      sourceAttempt.state.directiveDigest,
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
          phase: 'inbox_inputs_ready',
          sourceTurnId: sourceTurn.turnId,
          sourceAttemptId: sourceAttempt.attemptId,
          sourceDirectiveDigest: sourceAttempt.state.directiveDigest,
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

function invalid(message: string): AgentRunInvariantError {
  return new AgentRunInvariantError(message);
}

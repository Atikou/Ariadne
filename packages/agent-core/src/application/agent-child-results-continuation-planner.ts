import { assertValidAgentRun, type AgentRun } from '../domain/agent-run.js';
import { AgentRunInvariantError } from '../domain/errors.js';
import type { AgentTurnCause } from '../domain/turn.js';
import type { RegisterAgentTurnCommand } from './commands.js';
import type { AgentTurnInputModelData } from './agent-engine.js';
import {
  assertAgentRunCommitArtifactDigests,
  assertAgentTurnInputSnapshotMatchesTurn,
  type AgentRunCommitArtifacts,
  type AgentTurnInputSnapshotV1
} from './recovery-persistence.js';
import { canonicalizeAgentControlData } from './control-command-digest.js';
import { deriveStableAgentId } from './stable-id.js';
import { transitionAgentRun } from './transition-agent-run.js';
import {
  canonicalizeAgentTurnInput,
  digestAgentTurnInput,
  summarizeAgentTurnInput
} from './turn-input-digest.js';

export interface AgentTerminalChildResultEvidence {
  readonly delegationId: string;
  readonly childRunId: string;
  readonly childRunVersion: number;
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly content: string;
}

export interface AgentChildResultsContinuationPlan {
  readonly command: RegisterAgentTurnCommand;
  readonly artifacts: AgentRunCommitArtifacts;
}

/** Builds the exact parent continuation after all required child Runs settle. */
export class DefaultAgentChildResultsContinuationPlanner {
  public async plan(input: {
    readonly run: AgentRun;
    readonly sourceTurnInput: AgentTurnInputSnapshotV1;
    readonly results: readonly AgentTerminalChildResultEvidence[];
  }): Promise<AgentChildResultsContinuationPlan> {
    assertValidAgentRun(input.run);
    const run = input.run;
    if (
      run.state.status !== 'running'
      || input.results.length !== 1
      || run.turns.length >= run.binding.budget.vector.modelTurns
      || Date.parse(run.updatedAt) >= Date.parse(run.binding.budget.deadlineAt)
    ) throw invalid('SubAgent result continuation is outside its running Budget boundary.');
    const sourceTurn = run.turns.at(-1);
    const sourceAttempt = sourceTurn?.attempts.at(-1);
    if (
      sourceTurn === undefined
      || sourceAttempt?.state.status !== 'succeeded'
      || sourceAttempt.state.directive.kind !== 'delegate_subagent'
    ) throw invalid('SubAgent result continuation requires the latest delegation Directive.');
    await assertAgentTurnInputSnapshotMatchesTurn(
      run,
      sourceTurn.turnId,
      sourceTurn.intention.inputDigest,
      input.sourceTurnInput
    );
    const result = input.results[0];
    const directive = sourceAttempt.state.directive;
    if (
      result === undefined
      || result.delegationId !== directive.delegationId
      || result.childRunId !== directive.childRunId
      || !Number.isSafeInteger(result.childRunVersion)
      || result.childRunVersion < 1
      || result.content.length === 0
      || result.content.length > 1_048_576
    ) throw invalid('SubAgent terminal evidence differs from its committed Directive.');
    const cause: Extract<AgentTurnCause, { readonly kind: 'child_results' }> = {
      kind: 'child_results',
      sourceTurnId: sourceTurn.turnId,
      sourceAttemptId: sourceAttempt.attemptId,
      sourceDirectiveDigest: sourceAttempt.state.directiveDigest,
      delegationIds: [result.delegationId],
      childRunIds: [result.childRunId]
    };
    const assistantContent = canonicalizeAgentControlData({
      protocol: 'ariadne.agent-directive.v3',
      directive: {
        kind: 'delegate_subagent',
        delegationId: directive.delegationId,
        childRunId: directive.childRunId,
        objectiveDigest: directive.objectiveDigest,
        mode: directive.mode
      }
    });
    const childResultContent = canonicalizeAgentControlData({
      format: 'ariadne.subagent-results',
      schemaVersion: 1,
      results: [{
        delegationId: result.delegationId,
        childRunId: result.childRunId,
        childRunVersion: result.childRunVersion,
        status: result.status,
        content: result.content
      }]
    });
    const modelData = canonicalModelData({
      messages: [
        ...input.sourceTurnInput.messages,
        { kind: 'text', role: 'assistant', content: assistantContent },
        { kind: 'text', role: 'user', content: childResultContent }
      ],
      availableTools: input.sourceTurnInput.availableTools
    });
    const inputDigest = await digestAgentTurnInput(modelData);
    const identity = [
      run.runId,
      sourceTurn.turnId,
      sourceAttempt.attemptId,
      sourceAttempt.state.directiveDigest,
      result.delegationId,
      result.childRunId,
      String(result.childRunVersion),
      result.status
    ] as const;
    const [commandId, turnId, attemptId, providerIdempotencyKey] = await Promise.all([
      deriveStableAgentId('child-results-continuation', ...identity),
      deriveStableAgentId('child-results-turn', ...identity),
      deriveStableAgentId('child-results-attempt', ...identity),
      deriveStableAgentId('child-results-provider', ...identity)
    ]);
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
        inputSummary: summarizeAgentTurnInput(modelData)
      }
    };
    const artifacts: AgentRunCommitArtifacts = {
      checkpoint: {
        checkpointVersion: run.state.checkpointVersion + 1,
        createdAt: run.updatedAt,
        payload: {
          format: 'ariadne.agent-checkpoint',
          schemaVersion: 1,
          engineContinuation: {
            phase: 'child_results_ready',
            sourceTurnId: sourceTurn.turnId,
            sourceAttemptId: sourceAttempt.attemptId,
            sourceDirectiveDigest: sourceAttempt.state.directiveDigest,
            delegationIds: [...cause.delegationIds],
            childRunIds: [...cause.childRunIds],
            continuationTurnId: turnId,
            continuationAttemptId: attemptId
          },
          modelContext: null
        }
      },
      turnInputPayloads: [{
        turnId,
        inputDigest,
        payload: {
          format: 'ariadne.agent-turn-input',
          schemaVersion: 1,
          runId: run.runId,
          turnId,
          cause: {
            ...cause,
            delegationIds: [...cause.delegationIds],
            childRunIds: [...cause.childRunIds]
          },
          authorityRef: { ...input.sourceTurnInput.authorityRef },
          messages: modelData.messages,
          availableTools: modelData.availableTools
        },
        recordedAt: run.updatedAt
      }],
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

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
import { canonicalizeAgentControlData, sha256AgentControlData } from './control-command-digest.js';
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
      || run.turns.length >= run.binding.budget.vector.modelTurns
      || Date.parse(run.updatedAt) >= Date.parse(run.binding.budget.deadlineAt)
    ) throw invalid('SubAgent result continuation is outside its running Budget boundary.');
    const sourceTurn = run.turns.at(-1);
    const sourceAttempt = sourceTurn?.attempts.at(-1);
    if (
      sourceTurn === undefined
      || sourceAttempt?.state.status !== 'succeeded'
      || (sourceAttempt.state.directive.kind !== 'delegate_subagent'
        && sourceAttempt.state.directive.kind !== 'delegate_subagents')
    ) throw invalid('SubAgent result continuation requires the latest delegation Directive.');
    await assertAgentTurnInputSnapshotMatchesTurn(
      run,
      sourceTurn.turnId,
      sourceTurn.intention.inputDigest,
      input.sourceTurnInput
    );
    const directive = sourceAttempt.state.directive;
    const delegations = directive.kind === 'delegate_subagent'
      ? [directive]
      : directive.delegations;
    if (
      input.results.length !== delegations.length
      || input.results.some((result, index) => {
        const delegation = delegations[index];
        return delegation === undefined
          || result.delegationId !== delegation.delegationId
          || result.childRunId !== delegation.childRunId
          || !Number.isSafeInteger(result.childRunVersion)
          || result.childRunVersion < 1
          || result.content.length === 0
          || result.content.length > 1_048_576;
      })
    ) throw invalid('SubAgent terminal evidence differs from its committed Directive batch.');
    const cause: Extract<AgentTurnCause, { readonly kind: 'child_results' }> = {
      kind: 'child_results',
      sourceTurnId: sourceTurn.turnId,
      sourceAttemptId: sourceAttempt.attemptId,
      sourceDirectiveDigest: sourceAttempt.state.directiveDigest,
      delegationIds: input.results.map((result) => result.delegationId),
      childRunIds: input.results.map((result) => result.childRunId)
    };
    const assistantContent = canonicalizeAgentControlData({
      protocol: 'ariadne.agent-directive.v3',
      directive: directive.kind === 'delegate_subagent'
        ? {
            kind: 'delegate_subagent',
            delegationId: directive.delegationId,
            childRunId: directive.childRunId,
            objectiveDigest: directive.objectiveDigest,
            mode: directive.mode
          }
        : {
            kind: 'delegate_subagents',
            delegations: directive.delegations.map((delegation) => ({
              delegationId: delegation.delegationId,
              childRunId: delegation.childRunId,
              objectiveDigest: delegation.objectiveDigest,
              mode: delegation.mode
            }))
          }
    });
    const childResultContent = canonicalizeAgentControlData({
      format: 'ariadne.subagent-results',
      schemaVersion: 1,
      results: input.results.map((result) => ({
        delegationId: result.delegationId,
        childRunId: result.childRunId,
        childRunVersion: result.childRunVersion,
        status: result.status,
        content: result.content
      }))
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
    const resultIdentityDigest = await sha256AgentControlData(input.results.map((result) => ({
      delegationId: result.delegationId,
      childRunId: result.childRunId,
      childRunVersion: result.childRunVersion,
      status: result.status
    })));
    const identity = [
      run.runId,
      sourceTurn.turnId,
      sourceAttempt.attemptId,
      sourceAttempt.state.directiveDigest,
      resultIdentityDigest
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

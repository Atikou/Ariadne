import {
  assertValidAgentRun,
  type AgentRun,
  type AgentRunState
} from '../domain/agent-run.js';
import {
  assertAgentChildRunBindingSubset,
  cloneAgentRunBinding,
  type AgentBudgetVector,
  type AgentRunBinding
} from '../domain/run-binding.js';
import { AgentRunCommandConflictError, AgentRunInvariantError } from '../domain/errors.js';
import type { AgentRunEvent, AgentRunEventPayload } from './events.js';
import {
  EMPTY_AGENT_CONTROL_COMMIT_FACTS,
  type AgentBudgetSnapshot,
  type AgentControlCommitFacts
} from '../domain/plan-budget-delegation.js';
import type { AgentInferenceAttemptResult } from './commands.js';
import { admitAgentRun } from './admit-agent-run.js';
import { transitionAgentRun } from './transition-agent-run.js';
import {
  assertAgentRunCommitArtifactDigests,
  assertAgentRunCommitArtifacts,
  type AgentRunCommitArtifacts,
  type AgentTurnInputSnapshotV1
} from './recovery-persistence.js';
import type {
  AgentRunCommandCommit,
  AgentRunCommitMutation,
  AgentRunUnitOfWork,
  CommittedAgentRunCommand
} from './unit-of-work.js';
import type { AgentSubagentDelegationPlan } from './agent-inference-directive-planner.js';
import { sha256AgentControlData } from './control-command-digest.js';
import { deriveStableAgentId } from './stable-id.js';
import { digestAgentTurnInput, summarizeAgentTurnInput } from './turn-input-digest.js';
import { assertValidCommittedAgentDirective } from '../domain/directive.js';

export interface CommitAgentSubagentDelegationRequest {
  readonly commandId: string;
  readonly runId: string;
  readonly expectedVersion: number;
  readonly occurredAt: string;
  readonly turnId: string;
  readonly attemptId: string;
  readonly result: Extract<AgentInferenceAttemptResult, { readonly status: 'succeeded' }>;
  readonly parentArtifacts: AgentRunCommitArtifacts;
  readonly delegation: AgentSubagentDelegationPlan;
}

export interface AgentSubagentDelegationCommitResult {
  readonly commandId: string;
  readonly parent: AgentRun;
  readonly child: AgentRun;
  readonly parentEvents: readonly AgentRunEvent[];
  readonly replayed: boolean;
}

/**
 * Commits one model delegation as one parent-result plus admitted-child command.
 * Raw objectives exist only in protected Delegation/Turn-input payloads.
 */
export class AgentSubagentDelegationService {
  public constructor(private readonly unitOfWork: AgentRunUnitOfWork) {}

  public async commit(
    request: CommitAgentSubagentDelegationRequest
  ): Promise<AgentSubagentDelegationCommitResult> {
    const directive = request.result.directive;
    assertValidCommittedAgentDirective(directive);
    if (
      directive.kind !== 'delegate_subagent'
      || directive.delegationId !== request.delegation.delegationId
      || directive.childRunId !== request.delegation.childRunId
      || directive.objectiveDigest !== request.delegation.objectiveDigest
      || await sha256AgentControlData(request.delegation.objective)
        !== request.delegation.objectiveDigest
    ) {
      throw new AgentRunInvariantError(
        'SubAgent result must bind its exact protected Delegation plan.'
      );
    }
    const commandDigest = await sha256AgentControlData({
      kind: 'control.inference.delegate_subagent',
      commandId: request.commandId,
      runId: request.runId,
      expectedVersion: request.expectedVersion,
      occurredAt: request.occurredAt,
      turnId: request.turnId,
      attemptId: request.attemptId,
      result: request.result,
      delegationId: request.delegation.delegationId,
      childRunId: request.delegation.childRunId,
      childGrantId: request.delegation.childGrantId,
      objective: request.delegation.objective
    });

    return this.unitOfWork.transaction(async (transaction) => {
      const replay = await transaction.loadCommittedCommand(request.commandId);
      if (replay !== null) return replayResult(replay, request, commandDigest);
      const parent = await transaction.loadRun(request.runId);
      if (parent === null || parent.version !== request.expectedVersion) {
        throw new AgentRunInvariantError('SubAgent parent authority changed before commit.');
      }
      if (await transaction.loadRun(request.delegation.childRunId) !== null) {
        throw new AgentRunInvariantError('SubAgent child Run identity already exists.');
      }
      if (transaction.loadBudgetSnapshot === undefined) {
        throw new AgentRunInvariantError('SubAgent delegation requires durable Budget authority.');
      }
      const budget = await transaction.loadBudgetSnapshot(parent.binding.budget.grantId);
      assertExactBudget(parent, budget);
      const childVector = allocateChildBudget(budget.available);
      const childBinding = childBindingFromParent(
        parent,
        request.delegation,
        childVector
      );
      assertAgentChildRunBindingSubset(parent.runId, parent.binding, childBinding);

      const childTurnId = await deriveStableAgentId(
        'delegated-turn',
        request.delegation.childRunId,
        request.delegation.delegationId
      );
      const childAttemptId = await deriveStableAgentId(
        'delegated-attempt',
        request.delegation.childRunId,
        request.delegation.delegationId
      );
      const providerIdempotencyKey = await deriveStableAgentId(
        'delegated-provider',
        request.delegation.childRunId,
        request.delegation.delegationId
      );
      const childMessages = [
        ...request.delegation.sourceMessages.filter((message) => (
          message.kind === 'text' && message.role === 'system'
        )),
        {
          kind: 'text' as const,
          role: 'user' as const,
          content: request.delegation.prompt
        }
      ];
      const childModelInput = {
        messages: childMessages,
        availableTools: request.delegation.availableTools
      };
      const childInputDigest = await digestAgentTurnInput(childModelInput);
      const childCause = {
        kind: 'delegation_objective' as const,
        parentRunId: parent.runId,
        delegationId: request.delegation.delegationId,
        objectiveDigest: request.delegation.objectiveDigest
      };
      const childAdmission = admitAgentRun({
        kind: 'run.admit',
        commandId: request.commandId,
        runId: request.delegation.childRunId,
        occurredAt: request.occurredAt,
        binding: childBinding,
        turn: {
          cause: childCause,
          turnId: childTurnId,
          attemptId: childAttemptId,
          providerIdempotencyKey,
          inputDigest: childInputDigest,
          inputSummary: summarizeAgentTurnInput(childModelInput)
        }
      });
      const childTurnInput: AgentTurnInputSnapshotV1 = {
        format: 'ariadne.agent-turn-input',
        schemaVersion: 1,
        runId: request.delegation.childRunId,
        turnId: childTurnId,
        cause: childCause,
        authorityRef: {
          kind: 'parent_delegation',
          parentRunId: parent.runId,
          delegationId: request.delegation.delegationId,
          objectiveDigest: request.delegation.objectiveDigest
        },
        messages: childMessages,
        availableTools: request.delegation.availableTools
      };
      const childArtifacts: AgentRunCommitArtifacts = {
        checkpoint: {
          checkpointVersion: 1,
          createdAt: request.occurredAt,
          payload: {
            format: 'ariadne.agent-checkpoint',
            schemaVersion: 1,
            engineContinuation: {
              phase: 'delegation_objective',
              parentRunId: parent.runId,
              delegationId: request.delegation.delegationId
            },
            modelContext: null
          }
        },
        turnInputPayloads: [{
          turnId: childTurnId,
          inputDigest: childInputDigest,
          payload: childTurnInput,
          recordedAt: request.occurredAt
        }],
        effectPayloads: []
      };

      const resultTransition = transitionAgentRun(parent, {
        kind: 'run.record_inference_attempt_result',
        commandId: request.commandId,
        runId: parent.runId,
        expectedVersion: parent.version,
        occurredAt: request.occurredAt,
        turnId: request.turnId,
        attemptId: request.attemptId,
        result: request.result
      });
      const waitingState: AgentRunState = {
        status: 'waiting_children',
        checkpointVersion: resultTransition.run.state.checkpointVersion,
        enteredAt: request.occurredAt,
        requiredChildRunIds: [request.delegation.childRunId],
        terminalChildRunIds: []
      };
      const nextParent: AgentRun = {
        ...resultTransition.run,
        state: waitingState
      };
      assertValidAgentRun(nextParent);
      const parentPayloads = [
        ...resultTransition.events.filter((event) => event.type !== 'run.state_changed'),
        {
          type: 'children.delegated' as const,
          children: [{
            delegationId: request.delegation.delegationId,
            childRunId: request.delegation.childRunId,
            childGrantId: request.delegation.childGrantId,
            objectiveDigest: request.delegation.objectiveDigest,
            required: true
          }]
        },
        {
          type: 'run.state_changed' as const,
          from: parent.state.status,
          to: waitingState
        }
      ];
      const facts = delegationFacts(
        parent,
        request.delegation,
        childVector,
        request.occurredAt
      );
      const [parentEvents, childEvents] = await Promise.all([
        decorateEvents(request.commandId, nextParent, parentPayloads, request.occurredAt),
        decorateEvents(
          request.commandId,
          childAdmission.run,
          childAdmission.events,
          request.occurredAt
        )
      ]);
      const mutations: AgentRunCommitMutation[] = [
        {
          runId: nextParent.runId,
          expectedVersion: parent.version,
          resultingVersion: nextParent.version,
          run: nextParent,
          events: parentEvents,
          artifacts: request.parentArtifacts
        },
        {
          runId: childAdmission.run.runId,
          expectedVersion: null,
          resultingVersion: childAdmission.run.version,
          run: childAdmission.run,
          events: childEvents,
          artifacts: childArtifacts
        }
      ].sort((left, right) => codeUnitCompare(left.runId, right.runId));
      assertAgentRunCommitArtifacts(parent, nextParent, request.parentArtifacts);
      assertAgentRunCommitArtifacts(null, childAdmission.run, childArtifacts);
      await Promise.all([
        assertAgentRunCommitArtifactDigests(parent, nextParent, request.parentArtifacts),
        assertAgentRunCommitArtifactDigests(null, childAdmission.run, childArtifacts)
      ]);
      const commit: AgentRunCommandCommit = {
        commandId: request.commandId,
        commandDigest,
        mutations,
        facts
      };
      await transaction.commitCommand(commit);
      return {
        commandId: request.commandId,
        parent: nextParent,
        child: childAdmission.run,
        parentEvents,
        replayed: false
      };
    });
  }
}

function allocateChildBudget(available: AgentBudgetVector): AgentBudgetVector {
  if (available.modelTurns < 2) {
    throw new AgentRunInvariantError(
      'SubAgent delegation requires one child turn and one reserved parent continuation turn.'
    );
  }
  const half = (value: number): number => Math.floor(value / 2);
  return {
    modelTurns: Math.max(1, Math.min(8, half(available.modelTurns))),
    toolCalls: Math.min(16, half(available.toolCalls)),
    readCalls: Math.min(16, half(available.readCalls)),
    writeCalls: Math.min(16, half(available.writeCalls)),
    shellCalls: Math.min(8, half(available.shellCalls)),
    costMicrousd: half(available.costMicrousd)
  };
}

function childBindingFromParent(
  parent: AgentRun,
  plan: AgentSubagentDelegationPlan,
  vector: AgentBudgetVector
): AgentRunBinding {
  const cloned = cloneAgentRunBinding(parent.binding);
  return {
    ...cloned,
    objectiveRef: {
      kind: 'parent_delegation',
      parentRunId: parent.runId,
      delegationId: plan.delegationId,
      objectiveDigest: plan.objectiveDigest
    },
    budget: {
      grantId: plan.childGrantId,
      runId: plan.childRunId,
      vector: { ...vector },
      deadlineAt: parent.binding.budget.deadlineAt,
      source: {
        kind: 'parent_allocation',
        parentRunId: parent.runId,
        parentGrantId: parent.binding.budget.grantId,
        delegationId: plan.delegationId
      }
    }
  };
}

function delegationFacts(
  parent: AgentRun,
  plan: AgentSubagentDelegationPlan,
  vector: AgentBudgetVector,
  occurredAt: string
): AgentControlCommitFacts {
  return {
    ...EMPTY_AGENT_CONTROL_COMMIT_FACTS,
    budgetGrants: [{
      grantId: plan.childGrantId,
      runId: plan.childRunId,
      vector: { ...vector },
      deadlineAt: parent.binding.budget.deadlineAt,
      createdAt: occurredAt,
      source: {
        kind: 'parent_allocation',
        parentRunId: parent.runId,
        parentGrantId: parent.binding.budget.grantId,
        delegationId: plan.delegationId
      }
    }],
    budgetEntries: [{
      kind: 'parent_allocation',
      entryId: `budget-entry:allocation:${plan.delegationId}`,
      runId: parent.runId,
      grantId: parent.binding.budget.grantId,
      vector: { ...vector },
      delegationId: plan.delegationId,
      childRunId: plan.childRunId,
      childGrantId: plan.childGrantId,
      occurredAt
    }],
    delegations: [{
      delegationId: plan.delegationId,
      parentRunId: parent.runId,
      childRunId: plan.childRunId,
      parentGrantId: parent.binding.budget.grantId,
      childGrantId: plan.childGrantId,
      objectiveDigest: plan.objectiveDigest,
      objective: plan.objective,
      required: true,
      createdAt: occurredAt
    }]
  };
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function decorateEvents(
  commandId: string,
  run: AgentRun,
  payloads: readonly AgentRunEventPayload[],
  occurredAt: string
): Promise<readonly AgentRunEvent[]> {
  return Promise.all(payloads.map(async (payload, index) => ({
    eventId: await deriveStableAgentId(
      'event',
      commandId,
      run.runId,
      String(index + 1)
    ),
    commandId,
    runId: run.runId,
    runVersion: run.version,
    sequence: index + 1,
    occurredAt,
    payload
  })));
}

function assertExactBudget(
  run: AgentRun,
  budget: AgentBudgetSnapshot | null
): asserts budget is AgentBudgetSnapshot {
  if (
    budget === null
    || budget.grant.runId !== run.runId
    || budget.grant.grantId !== run.binding.budget.grantId
    || budget.grant.deadlineAt !== run.binding.budget.deadlineAt
  ) {
    throw new AgentRunInvariantError('SubAgent parent Budget authority is unavailable.');
  }
}

function replayResult(
  committed: CommittedAgentRunCommand,
  request: CommitAgentSubagentDelegationRequest,
  commandDigest: string
): AgentSubagentDelegationCommitResult {
  const parent = committed.mutations.find((item) => item.runId === request.runId);
  const child = committed.mutations.find(
    (item) => item.runId === request.delegation.childRunId
  );
  if (
    committed.commandDigest !== commandDigest
    || committed.mutations.length !== 2
    || parent === undefined
    || child === undefined
  ) {
    throw new AgentRunCommandConflictError(
      request.commandId,
      parent?.runId ?? request.runId,
      request.runId,
      'command_mismatch'
    );
  }
  return {
    commandId: committed.commandId,
    parent: parent.run,
    child: child.run,
    parentEvents: parent.events,
    replayed: true
  };
}

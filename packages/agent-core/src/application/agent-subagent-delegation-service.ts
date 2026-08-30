import {
  assertValidAgentRun,
  type AgentRun,
  type AgentRunState
} from '../domain/agent-run.js';
import {
  assertAgentChildRunBindingSubset,
  cloneAgentRunBinding,
  DEFAULT_AGENT_SUBAGENT_PROVIDER_BINDING,
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

interface CommitAgentSubagentDelegationBase {
  readonly commandId: string;
  readonly runId: string;
  readonly expectedVersion: number;
  readonly occurredAt: string;
  readonly turnId: string;
  readonly attemptId: string;
  readonly result: Extract<AgentInferenceAttemptResult, { readonly status: 'succeeded' }>;
  readonly parentArtifacts: AgentRunCommitArtifacts;
}

export interface CommitAgentSubagentDelegationRequest
  extends CommitAgentSubagentDelegationBase {
  readonly delegation: AgentSubagentDelegationPlan;
}

export interface CommitAgentSubagentDelegationsRequest
  extends CommitAgentSubagentDelegationBase {
  readonly delegations: readonly AgentSubagentDelegationPlan[];
}

export interface AgentSubagentDelegationCommitResult {
  readonly commandId: string;
  readonly parent: AgentRun;
  readonly child: AgentRun;
  readonly parentEvents: readonly AgentRunEvent[];
  readonly replayed: boolean;
}

export interface AgentSubagentDelegationsCommitResult {
  readonly commandId: string;
  readonly parent: AgentRun;
  readonly children: readonly AgentRun[];
  readonly parentEvents: readonly AgentRunEvent[];
  readonly replayed: boolean;
}

interface PreparedChild {
  readonly plan: AgentSubagentDelegationPlan;
  readonly run: AgentRun;
  readonly events: readonly AgentRunEventPayload[];
  readonly artifacts: AgentRunCommitArtifacts;
  readonly vector: AgentBudgetVector;
}

/** Atomically commits one model delegation batch as one parent result plus admitted children. */
export class AgentSubagentDelegationService {
  public constructor(private readonly unitOfWork: AgentRunUnitOfWork) {}

  public async commit(
    request: CommitAgentSubagentDelegationRequest
  ): Promise<AgentSubagentDelegationCommitResult> {
    const committed = await this.commitBatch({ ...request, delegations: [request.delegation] });
    const child = committed.children[0];
    if (child === undefined) throw new AgentRunInvariantError('SubAgent child is unavailable.');
    return { ...committed, child };
  }

  public async commitBatch(
    request: CommitAgentSubagentDelegationsRequest
  ): Promise<AgentSubagentDelegationsCommitResult> {
    await assertExactDelegationPlans(request.result, request.delegations);
    const only = request.delegations.length === 1 ? request.delegations[0] : undefined;
    const commandDigest = await sha256AgentControlData(only === undefined ? {
      kind: 'control.inference.delegate_subagents',
      commandId: request.commandId,
      runId: request.runId,
      expectedVersion: request.expectedVersion,
      occurredAt: request.occurredAt,
      turnId: request.turnId,
      attemptId: request.attemptId,
      result: request.result,
      delegations: request.delegations.map((delegation) => ({
        delegationId: delegation.delegationId,
        childRunId: delegation.childRunId,
        childGrantId: delegation.childGrantId,
        objective: delegation.objective
      }))
    } : {
      kind: 'control.inference.delegate_subagent',
      commandId: request.commandId,
      runId: request.runId,
      expectedVersion: request.expectedVersion,
      occurredAt: request.occurredAt,
      turnId: request.turnId,
      attemptId: request.attemptId,
      result: request.result,
      delegationId: only.delegationId,
      childRunId: only.childRunId,
      childGrantId: only.childGrantId,
      objective: only.objective
    });

    return this.unitOfWork.transaction(async (transaction) => {
      const replay = await transaction.loadCommittedCommand(request.commandId);
      if (replay !== null) return replayResult(replay, request, commandDigest);
      const parent = await transaction.loadRun(request.runId);
      if (parent === null || parent.version !== request.expectedVersion) {
        throw new AgentRunInvariantError('SubAgent parent authority changed before commit.');
      }
      for (const plan of request.delegations) {
        if (await transaction.loadRun(plan.childRunId) !== null) {
          throw new AgentRunInvariantError('SubAgent child Run identity already exists.');
        }
      }
      if (transaction.loadBudgetSnapshot === undefined) {
        throw new AgentRunInvariantError('SubAgent delegation requires durable Budget authority.');
      }
      const budget = await transaction.loadBudgetSnapshot(parent.binding.budget.grantId);
      assertExactBudget(parent, budget);
      const childVector = allocateChildBudget(budget.available, request.delegations.length);
      const children = await Promise.all(request.delegations.map((plan) =>
        prepareChild(parent, plan, childVector, request)
      ));

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
      const requiredChildRunIds = children.map((child) => child.run.runId).sort(codeUnitCompare);
      const waitingState: AgentRunState = {
        status: 'waiting_children',
        checkpointVersion: resultTransition.run.state.checkpointVersion,
        enteredAt: request.occurredAt,
        requiredChildRunIds,
        terminalChildRunIds: []
      };
      const nextParent: AgentRun = { ...resultTransition.run, state: waitingState };
      assertValidAgentRun(nextParent);
      const parentPayloads: readonly AgentRunEventPayload[] = [
        ...resultTransition.events.filter((event) => event.type !== 'run.state_changed'),
        {
          type: 'children.delegated',
          children: children.map(({ plan }) => ({
            delegationId: plan.delegationId,
            childRunId: plan.childRunId,
            childGrantId: plan.childGrantId,
            objectiveDigest: plan.objectiveDigest,
            required: true
          }))
        },
        { type: 'run.state_changed', from: parent.state.status, to: waitingState }
      ];
      const parentEvents = await decorateEvents(
        request.commandId,
        nextParent,
        parentPayloads,
        request.occurredAt
      );
      const childEvents = await Promise.all(children.map((child) => decorateEvents(
        request.commandId,
        child.run,
        child.events,
        request.occurredAt
      )));
      const mutations: AgentRunCommitMutation[] = [{
        runId: nextParent.runId,
        expectedVersion: parent.version,
        resultingVersion: nextParent.version,
        run: nextParent,
        events: parentEvents,
        artifacts: request.parentArtifacts
      }, ...children.map((child, index): AgentRunCommitMutation => ({
        runId: child.run.runId,
        expectedVersion: null,
        resultingVersion: child.run.version,
        run: child.run,
        events: childEvents[index] ?? [],
        artifacts: child.artifacts
      }))].sort((left, right) => codeUnitCompare(left.runId, right.runId));
      assertAgentRunCommitArtifacts(parent, nextParent, request.parentArtifacts);
      children.forEach((child) => assertAgentRunCommitArtifacts(null, child.run, child.artifacts));
      await Promise.all([
        assertAgentRunCommitArtifactDigests(parent, nextParent, request.parentArtifacts),
        ...children.map((child) => assertAgentRunCommitArtifactDigests(null, child.run, child.artifacts))
      ]);
      const commit: AgentRunCommandCommit = {
        commandId: request.commandId,
        commandDigest,
        mutations,
        facts: delegationFacts(parent, children, request.occurredAt)
      };
      await transaction.commitCommand(commit);
      return {
        commandId: request.commandId,
        parent: nextParent,
        children: children.map((child) => child.run),
        parentEvents,
        replayed: false
      };
    });
  }
}

async function assertExactDelegationPlans(
  result: Extract<AgentInferenceAttemptResult, { readonly status: 'succeeded' }>,
  plans: readonly AgentSubagentDelegationPlan[]
): Promise<void> {
  const directive = result.directive;
  assertValidCommittedAgentDirective(directive);
  const committed = directive.kind === 'delegate_subagent'
    ? [{
        delegationId: directive.delegationId,
        childRunId: directive.childRunId,
        objectiveDigest: directive.objectiveDigest,
        mode: directive.mode,
        providerId: directive.providerId
      }]
    : directive.kind === 'delegate_subagents'
      ? directive.delegations
      : [];
  if (plans.length === 0 || plans.length !== committed.length) {
    throw new AgentRunInvariantError('SubAgent result must bind its exact delegation batch.');
  }
  const objectiveDigests = await Promise.all(plans.map((plan) => sha256AgentControlData(plan.objective)));
  plans.forEach((plan, index) => {
    const item = committed[index];
    if (
      item === undefined
      || item.delegationId !== plan.delegationId
      || item.childRunId !== plan.childRunId
      || item.objectiveDigest !== plan.objectiveDigest
      || item.mode !== plan.mode
      || item.providerId !== plan.providerId
      || objectiveDigests[index] !== plan.objectiveDigest
    ) throw new AgentRunInvariantError('SubAgent result must bind its exact protected Delegation plan.');
  });
}

async function prepareChild(
  parent: AgentRun,
  plan: AgentSubagentDelegationPlan,
  vector: AgentBudgetVector,
  request: CommitAgentSubagentDelegationsRequest
): Promise<PreparedChild> {
  const childBinding = childBindingFromParent(parent, plan, vector);
  assertAgentChildRunBindingSubset(parent.runId, parent.binding, childBinding);
  const [childTurnId, childAttemptId, providerIdempotencyKey] = await Promise.all([
    deriveStableAgentId('delegated-turn', plan.childRunId, plan.delegationId),
    deriveStableAgentId('delegated-attempt', plan.childRunId, plan.delegationId),
    deriveStableAgentId('delegated-provider', plan.childRunId, plan.delegationId)
  ]);
  const provider = selectedSubagentProvider(parent.binding, plan.providerId);
  const childMessages = [
    ...(provider.inheritsParentContext
      ? plan.sourceMessages.filter((message) => message.kind === 'text' && message.role === 'system')
      : []),
    { kind: 'text' as const, role: 'user' as const, content: plan.prompt }
  ];
  const childAvailableTools = provider.usesParentTools ? plan.availableTools : [];
  const childModelInput = { messages: childMessages, availableTools: childAvailableTools };
  const childInputDigest = await digestAgentTurnInput(childModelInput);
  const childCause = {
    kind: 'delegation_objective' as const,
    parentRunId: parent.runId,
    delegationId: plan.delegationId,
    objectiveDigest: plan.objectiveDigest
  };
  const admission = admitAgentRun({
    kind: 'run.admit',
    commandId: request.commandId,
    runId: plan.childRunId,
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
    runId: plan.childRunId,
    turnId: childTurnId,
    cause: childCause,
    authorityRef: {
      kind: 'parent_delegation',
      parentRunId: parent.runId,
      delegationId: plan.delegationId,
      objectiveDigest: plan.objectiveDigest,
      mode: plan.mode,
      providerId: plan.providerId
    },
    messages: childMessages,
    availableTools: childAvailableTools
  };
  return {
    plan,
    run: admission.run,
    events: admission.events,
    vector,
    artifacts: {
      checkpoint: {
        checkpointVersion: 1,
        createdAt: request.occurredAt,
        payload: {
          format: 'ariadne.agent-checkpoint',
          schemaVersion: 1,
          engineContinuation: {
            phase: 'delegation_objective',
            parentRunId: parent.runId,
            delegationId: plan.delegationId
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
    }
  };
}

function selectedSubagentProvider(binding: AgentRunBinding, providerId: string) {
  const providers = binding.bindingVersion === 4
    ? binding.executionProfile.subagentProviders
    : undefined;
  const provider = (providers ?? [DEFAULT_AGENT_SUBAGENT_PROVIDER_BINDING]).find(
    (candidate) => candidate.providerId === providerId
  );
  if (provider === undefined) {
    throw new AgentRunInvariantError('SubAgent delegation selected a Provider outside the pinned Catalog.');
  }
  return provider;
}

function allocateChildBudget(available: AgentBudgetVector, childCount: number): AgentBudgetVector {
  if (childCount < 1 || available.modelTurns < childCount + 1) {
    throw new AgentRunInvariantError(
      'SubAgent delegation requires one child turn per child and one reserved parent continuation turn.'
    );
  }
  const share = (value: number): number => Math.floor(value / (childCount + 1));
  return {
    modelTurns: Math.max(1, Math.min(8, share(available.modelTurns))),
    toolCalls: Math.min(16, share(available.toolCalls)),
    readCalls: Math.min(16, share(available.readCalls)),
    writeCalls: Math.min(16, share(available.writeCalls)),
    shellCalls: Math.min(8, share(available.shellCalls)),
    costMicrousd: share(available.costMicrousd)
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
      objectiveDigest: plan.objectiveDigest,
      mode: plan.mode,
      providerId: plan.providerId
    },
    budget: {
      grantId: plan.childGrantId,
      runId: plan.childRunId,
      vector: { ...vector },
      deadlineAt: parent.binding.budget.deadlineAt,
      source: {
        kind: 'parent_allocation' as const,
        parentRunId: parent.runId,
        parentGrantId: parent.binding.budget.grantId,
        delegationId: plan.delegationId
      }
    }
  };
}

function delegationFacts(
  parent: AgentRun,
  children: readonly PreparedChild[],
  occurredAt: string
): AgentControlCommitFacts {
  return {
    ...EMPTY_AGENT_CONTROL_COMMIT_FACTS,
    budgetGrants: children.map(({ plan, vector }) => ({
      grantId: plan.childGrantId,
      runId: plan.childRunId,
      vector: { ...vector },
      deadlineAt: parent.binding.budget.deadlineAt,
      createdAt: occurredAt,
      source: {
        kind: 'parent_allocation' as const,
        parentRunId: parent.runId,
        parentGrantId: parent.binding.budget.grantId,
        delegationId: plan.delegationId
      }
    })).sort((left, right) => codeUnitCompare(left.grantId, right.grantId)),
    budgetEntries: children.map(({ plan, vector }) => ({
      kind: 'parent_allocation' as const,
      entryId: `budget-entry:allocation:${plan.delegationId}`,
      runId: parent.runId,
      grantId: parent.binding.budget.grantId,
      vector: { ...vector },
      delegationId: plan.delegationId,
      childRunId: plan.childRunId,
      childGrantId: plan.childGrantId,
      occurredAt
    })).sort((left, right) => codeUnitCompare(left.entryId, right.entryId)),
    delegations: children.map(({ plan }) => ({
      delegationId: plan.delegationId,
      parentRunId: parent.runId,
      childRunId: plan.childRunId,
      parentGrantId: parent.binding.budget.grantId,
      childGrantId: plan.childGrantId,
      objectiveDigest: plan.objectiveDigest,
      objective: plan.objective,
      required: true,
      createdAt: occurredAt
    })).sort((left, right) => codeUnitCompare(left.delegationId, right.delegationId))
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
    eventId: await deriveStableAgentId('event', commandId, run.runId, String(index + 1)),
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
  ) throw new AgentRunInvariantError('SubAgent parent Budget authority is unavailable.');
}

function replayResult(
  committed: CommittedAgentRunCommand,
  request: CommitAgentSubagentDelegationsRequest,
  commandDigest: string
): AgentSubagentDelegationsCommitResult {
  const parent = committed.mutations.find((item) => item.runId === request.runId);
  const children = request.delegations.map((delegation) => committed.mutations.find(
    (item) => item.runId === delegation.childRunId
  ));
  if (
    committed.commandDigest !== commandDigest
    || committed.mutations.length !== request.delegations.length + 1
    || parent === undefined
    || children.some((child) => child === undefined)
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
    children: children.map((child) => child!.run),
    parentEvents: parent.events,
    replayed: true
  };
}

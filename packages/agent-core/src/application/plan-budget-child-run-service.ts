import {
  AgentRunAlreadyExistsError,
  AgentRunCommandConflictError,
  AgentRunInvariantError,
  AgentRunNotFoundError,
  AgentRunVersionConflictError
} from '../domain/errors.js';
import {
  assertValidAgentRun,
  isTerminalAgentRun,
  type AgentRun,
  type AgentRunState
} from '../domain/agent-run.js';
import {
  assertAgentChildRunBindingSubset,
  assertValidAgentRunBinding,
  cloneAgentRunBinding,
  type AgentBudgetVector,
  type AgentRunBinding
} from '../domain/run-binding.js';
import {
  EMPTY_AGENT_CONTROL_COMMIT_FACTS,
  addAgentBudgetVectors,
  agentBudgetVectorFits,
  assertAgentBudgetVector,
  assertAgentControlCommitFacts,
  assertAgentControlJsonValue,
  assertAgentPlanReference,
  cloneAgentControlJsonValue,
  isZeroAgentBudgetVector,
  type AgentBudgetLedgerEntryCommit,
  type AgentBudgetSnapshot,
  type AgentChildTerminalCommit,
  type AgentControlCommitFacts,
  type AgentControlJsonValue,
  type AgentDelegationCommit,
  type AgentDelegationRecord,
  type AgentPlanApprovalCommit,
  type AgentPlanReference,
  type AgentPlanVersionCommit,
  zeroAgentBudgetVector
} from '../domain/plan-budget-delegation.js';
import {
  assertCanonicalPublicId,
  assertPositiveInteger,
  assertTimestamp
} from '../domain/values.js';
import { isTerminalEffect } from '../domain/effect.js';
import { isTerminalInferenceAttempt } from '../domain/turn.js';
import { sha256AgentControlData } from './control-command-digest.js';
import { transitionAgentRun } from './transition-agent-run.js';
import type { AgentRunEvent, AgentRunEventPayload } from './events.js';
import type {
  AgentRunCommandCommit,
  AgentRunCommitMutation,
  AgentRunTransaction,
  AgentRunUnitOfWork,
  CommittedAgentRunCommand,
  CommittedAgentRunMutation
} from './unit-of-work.js';
import type { AgentRunCommitArtifacts } from './recovery-persistence.js';

interface ControlCommandBase {
  readonly commandId: string;
  readonly runId: string;
  readonly expectedVersion: number;
  readonly occurredAt: string;
}

export interface CreateAgentPlanVersionCommand extends ControlCommandBase {
  readonly kind: 'control.plan.create_and_request_approval';
  readonly decisionId: string;
  readonly plan: {
    readonly ref: AgentPlanReference;
    readonly payload: AgentControlJsonValue;
  };
}

export interface ApproveAgentPlanCommand extends ControlCommandBase {
  readonly kind: 'control.plan.approve';
  readonly approvalId: string;
  readonly decisionId: string;
  readonly checkpointVersion: number;
  readonly plan: AgentPlanReference;
}

export interface ReserveAgentBudgetCommand extends ControlCommandBase {
  readonly kind: 'control.budget.reserve';
  readonly entryId: string;
  readonly reservationId: string;
  readonly vector: AgentBudgetVector;
}

export interface SettleAgentBudgetCommand extends ControlCommandBase {
  readonly kind: 'control.budget.settle';
  readonly entryId: string;
  readonly reservationId: string;
  readonly actual: AgentBudgetVector;
}

export interface ReleaseAgentBudgetCommand extends ControlCommandBase {
  readonly kind: 'control.budget.release';
  readonly entryId: string;
  readonly reservationId: string;
}

export interface DelegateAgentChildRunsCommand extends ControlCommandBase {
  readonly kind: 'control.children.delegate';
  readonly children: readonly {
    readonly delegationId: string;
    readonly runId: string;
    readonly binding: AgentRunBinding;
    readonly objective: AgentControlJsonValue;
    readonly required: boolean;
  }[];
}

export interface ObserveAgentChildTerminalCommand extends ControlCommandBase {
  readonly kind: 'control.children.observe_terminal';
  readonly childRunId: string;
  readonly childRunVersion: number;
  readonly childStatus: 'completed' | 'failed' | 'cancelled';
}

export interface RequestAgentParentCancellationCommand extends ControlCommandBase {
  readonly kind: 'control.children.request_parent_cancellation';
  readonly reason: string;
}

export interface AgentControlCommandResult {
  readonly commandId: string;
  readonly mutations: readonly CommittedAgentRunMutation[];
  readonly replayed: boolean;
  readonly idempotent: boolean;
}

/**
 * Offline control vertical slice for immutable plans, vector budgets and
 * ordinary delegated AgentRuns. Every write is one AgentRunUnitOfWork command.
 */
export class AgentPlanBudgetChildRunService {
  public constructor(private readonly unitOfWork: AgentRunUnitOfWork) {}

  public async createPlanVersionAndRequestApproval(
    input: CreateAgentPlanVersionCommand
  ): Promise<AgentControlCommandResult> {
    const command = snapshotCreatePlanCommand(input);
    const actualHash = await sha256AgentControlData(command.plan.payload);
    if (actualHash !== command.plan.ref.contentHash) {
      throw new AgentRunInvariantError(
        'The immutable Plan content hash does not match its canonical payload.'
      );
    }
    const digest = await sha256AgentControlData(command);
    const facts: AgentControlCommitFacts = {
      ...EMPTY_AGENT_CONTROL_COMMIT_FACTS,
      planVersions: [{
        ref: command.plan.ref,
        runId: command.runId,
        payload: command.plan.payload,
        createdAt: command.occurredAt
      }]
    };

    return this.unitOfWork.transaction(async (transaction) => {
      const replay = await loadExactReplay(transaction, command.commandId, digest, facts);
      if (replay !== null) return replay;
      const current = await requireExpectedRun(transaction, command);
      if (await requireControl(transaction).loadPlanVersion(command.plan.ref) !== null) {
        throw new AgentRunInvariantError('An immutable Plan version already exists.');
      }
      const transition = transitionAgentRun(current, {
        kind: 'run.request_decision',
        commandId: command.commandId,
        runId: command.runId,
        expectedVersion: command.expectedVersion,
        occurredAt: command.occurredAt,
        decision: {
          kind: 'plan',
          decisionId: command.decisionId,
          planId: command.plan.ref.planId,
          planVersion: command.plan.ref.version,
          planHash: command.plan.ref.contentHash,
          requestedAt: command.occurredAt
        }
      });
      const mutation = createMutation(
        current,
        transition.run,
        command.commandId,
        digest,
        command.occurredAt,
        [
          ...transition.events,
          {
            type: 'plan.version_created',
            planId: command.plan.ref.planId,
            planVersion: command.plan.ref.version,
            contentHash: command.plan.ref.contentHash
          }
        ],
        checkpointArtifacts(transition.run, command.occurredAt, {
          phase: 'plan_approval',
          plan: command.plan.ref
        })
      );
      return commitNew(transaction, command.commandId, digest, [mutation], facts);
    });
  }

  public async approvePlan(
    input: ApproveAgentPlanCommand
  ): Promise<AgentControlCommandResult> {
    const command = snapshotApprovePlanCommand(input);
    const digest = await sha256AgentControlData(command);
    const approval: AgentPlanApprovalCommit = {
      approvalId: command.approvalId,
      decisionId: command.decisionId,
      runId: command.runId,
      checkpointVersion: command.checkpointVersion,
      plan: command.plan,
      approvedAt: command.occurredAt
    };
    const facts: AgentControlCommitFacts = {
      ...EMPTY_AGENT_CONTROL_COMMIT_FACTS,
      planApprovals: [approval]
    };

    return this.unitOfWork.transaction(async (transaction) => {
      const replay = await loadExactReplay(transaction, command.commandId, digest, facts);
      if (replay !== null) return replay;
      const current = await requireExpectedRun(transaction, command);
      const plan = await requireControl(transaction).loadPlanVersion(command.plan);
      if (
        plan === null
        || plan.runId !== command.runId
        || await sha256AgentControlData(plan.payload) !== command.plan.contentHash
      ) {
        throw new AgentRunInvariantError(
          'Plan approval requires the exact intact protected Plan version.'
        );
      }
      if (
        current.state.status !== 'waiting'
        || current.state.reason !== 'plan_approval'
        || current.state.checkpointVersion !== command.checkpointVersion
      ) {
        throw new AgentRunInvariantError(
          'Plan approval must bind the active Run checkpoint exactly.'
        );
      }
      const transition = transitionAgentRun(current, {
        kind: 'run.resolve_decision',
        commandId: command.commandId,
        runId: command.runId,
        expectedVersion: command.expectedVersion,
        occurredAt: command.occurredAt,
        resolution: {
          kind: 'plan',
          decisionId: command.decisionId,
          checkpoint: {
            runId: command.runId,
            version: command.checkpointVersion
          },
          planId: command.plan.planId,
          planVersion: command.plan.version,
          planHash: command.plan.contentHash,
          outcome: 'approve',
          resolvedAt: command.occurredAt
        }
      });
      const mutation = createMutation(
        current,
        transition.run,
        command.commandId,
        digest,
        command.occurredAt,
        [
          ...transition.events,
          {
            type: 'plan.approved',
            approvalId: command.approvalId,
            decisionId: command.decisionId,
            planId: command.plan.planId,
            planVersion: command.plan.version,
            contentHash: command.plan.contentHash
          }
        ],
        checkpointArtifacts(transition.run, command.occurredAt, {
          phase: 'plan_approved',
          plan: command.plan,
          approvalId: command.approvalId
        })
      );
      return commitNew(transaction, command.commandId, digest, [mutation], facts);
    });
  }

  public reserveBudget(
    input: ReserveAgentBudgetCommand
  ): Promise<AgentControlCommandResult> {
    return this.applyBudgetMutation(snapshotReserveBudgetCommand(input));
  }

  public settleBudget(
    input: SettleAgentBudgetCommand
  ): Promise<AgentControlCommandResult> {
    return this.applyBudgetMutation(snapshotSettleBudgetCommand(input));
  }

  public releaseBudget(
    input: ReleaseAgentBudgetCommand
  ): Promise<AgentControlCommandResult> {
    return this.applyBudgetMutation(snapshotReleaseBudgetCommand(input));
  }

  public async delegateChildren(
    input: DelegateAgentChildRunsCommand
  ): Promise<AgentControlCommandResult> {
    const command = snapshotDelegateChildrenCommand(input);
    const childDigests = await Promise.all(command.children.map((child) =>
      sha256AgentControlData(child.objective)
    ));
    command.children.forEach((child, index) => {
      const objectiveRef = child.binding.objectiveRef;
      if (
        objectiveRef.kind !== 'parent_delegation'
        || childDigests[index] !== objectiveRef.objectiveDigest
      ) {
        throw new AgentRunInvariantError(
          `Delegation "${child.delegationId}" objective digest does not match its protected payload.`
        );
      }
    });
    const digest = await sha256AgentControlData(command);
    const facts = createDelegationFacts(command);

    return this.unitOfWork.transaction(async (transaction) => {
      const replay = await loadExactReplay(transaction, command.commandId, digest, facts);
      if (replay !== null) return replay;
      const parent = await requireExpectedRun(transaction, command);
      requireDelegatableParent(parent);
      const control = requireControl(transaction);
      const parentBudget = await control.loadBudgetSnapshot(parent.binding.budget.grantId);
      requireBudgetSnapshot(parent, parentBudget);

      let allocated = zeroAgentBudgetVector();
      for (const child of command.children) {
        if (await transaction.loadRun(child.runId) !== null) {
          throw new AgentRunAlreadyExistsError(child.runId);
        }
        assertAgentChildRunBindingSubset(parent.runId, parent.binding, child.binding);
        if (
          child.binding.objectiveRef.kind !== 'parent_delegation'
          || child.binding.objectiveRef.delegationId !== child.delegationId
          || child.binding.budget.runId !== child.runId
        ) {
          throw new AgentRunInvariantError(
            'Every child binding must match its exact Run and Delegation identity.'
          );
        }
        allocated = addAgentBudgetVectors(
          allocated,
          child.binding.budget.vector,
          'sibling allocation'
        );
      }
      if (!agentBudgetVectorFits(allocated, parentBudget.available)) {
        throw new AgentRunInvariantError(
          'Sibling allocations exceed the parent Budget balance.'
        );
      }

      const requiredChildRunIds = command.children
        .filter((child) => child.required)
        .map((child) => child.runId);
      if (requiredChildRunIds.length === 0) {
        throw new AgentRunInvariantError('At least one delegated child must be required.');
      }
      const parentState: AgentRunState = {
        status: 'waiting_children',
        checkpointVersion: parent.state.checkpointVersion + 1,
        enteredAt: command.occurredAt,
        requiredChildRunIds,
        terminalChildRunIds: []
      };
      const nextParent: AgentRun = {
        ...parent,
        version: parent.version + 1,
        state: parentState,
        updatedAt: command.occurredAt
      };
      assertValidAgentRun(nextParent);

      const parentMutation = createMutation(
        parent,
        nextParent,
        command.commandId,
        digest,
        command.occurredAt,
        [{
          type: 'children.delegated',
          children: command.children.map((child) => ({
            delegationId: child.delegationId,
            childRunId: child.runId,
            childGrantId: child.binding.budget.grantId,
            objectiveDigest: child.binding.objectiveRef.kind === 'parent_delegation'
              ? child.binding.objectiveRef.objectiveDigest
              : 'invalid',
            required: child.required
          }))
        }],
        checkpointArtifacts(nextParent, command.occurredAt, {
          phase: 'waiting_children',
          requiredChildRunIds
        })
      );
      const childMutations = command.children.map((child) => {
        const run: AgentRun = {
          runId: child.runId,
          version: 1,
          binding: cloneAgentRunBinding(child.binding),
          state: {
            status: 'queued',
            checkpointVersion: 0,
            queuedAt: command.occurredAt
          },
          turns: [],
          effects: [],
          inbox: [],
          createdAt: command.occurredAt,
          updatedAt: command.occurredAt
        };
        assertValidAgentRun(run);
        return createMutation(
          null,
          run,
          command.commandId,
          digest,
          command.occurredAt,
          [{ type: 'run.started', binding: run.binding }],
          { turnInputPayloads: [], effectPayloads: [] }
        );
      });
      const mutations = [parentMutation, ...childMutations]
        .sort((left, right) => codeUnitCompare(left.runId, right.runId));
      return commitNew(transaction, command.commandId, digest, mutations, facts);
    });
  }

  public async observeChildTerminal(
    input: ObserveAgentChildTerminalCommand
  ): Promise<AgentControlCommandResult> {
    const command = snapshotObserveChildTerminalCommand(input);
    const digest = await sha256AgentControlData(command);
    return this.unitOfWork.transaction(async (transaction) => {
      const committed = await transaction.loadCommittedCommand(command.commandId);
      if (committed !== null) return assertReplayDigest(committed, digest);
      const control = requireControl(transaction);
      const delegation = await control.loadDelegationByChild(command.childRunId);
      if (delegation === null || delegation.parentRunId !== command.runId) {
        throw new AgentRunInvariantError('Child terminal report has no exact Delegation.');
      }
      const existing = await control.loadChildTerminal(delegation.delegationId);
      if (existing !== null) {
        if (
          existing.childRunVersion !== command.childRunVersion
          || existing.childStatus !== command.childStatus
        ) {
          throw new AgentRunInvariantError('A child terminal fact is immutable.');
        }
        const parent = await transaction.loadRun(command.runId);
        if (parent === null) throw new AgentRunNotFoundError(command.runId);
        return {
          commandId: command.commandId,
          mutations: [{
            runId: parent.runId,
            resultingVersion: parent.version,
            run: parent,
            events: []
          }],
          replayed: false,
          idempotent: true
        };
      }

      const parent = await requireExpectedRun(transaction, command);
      const child = await transaction.loadRun(command.childRunId);
      if (
        child === null
        || child.version !== command.childRunVersion
        || !isTerminalAgentRun(child)
        || child.state.status !== command.childStatus
      ) {
        throw new AgentRunInvariantError(
          'Child terminal propagation requires the exact durable terminal child version.'
        );
      }
      const childBudget = await control.loadBudgetSnapshot(child.binding.budget.grantId);
      requireBudgetSnapshot(child, childBudget);
      if (childBudget.openReservations.length > 0) {
        throw new AgentRunInvariantError(
          'A child with an uncertain Budget reservation is not terminal-safe.'
        );
      }
      await assertAllRequiredDescendantsTerminal(control, child.runId);
      const delegations = await control.listDelegationsByParent(parent.runId);
      const required = delegations.filter((item) => item.required);
      const terminalChildRunIds = required
        .filter((item) => item.terminal !== null || item.delegationId === delegation.delegationId)
        .map((item) => item.childRunId)
        .sort(codeUnitCompare);
      const allRequiredTerminal = terminalChildRunIds.length === required.length;
      const nextParent = transitionParentAfterChildTerminal(
        parent,
        command,
        terminalChildRunIds,
        allRequiredTerminal
      );

      const terminalFact: AgentChildTerminalCommit = {
        delegationId: delegation.delegationId,
        parentRunId: parent.runId,
        childRunId: child.runId,
        childRunVersion: child.version,
        childStatus: command.childStatus,
        observedAt: command.occurredAt
      };
      const releaseEntry: AgentBudgetLedgerEntryCommit = {
        kind: 'child_release',
        entryId: `budget-entry:child-release:${delegation.delegationId}`,
        runId: parent.runId,
        grantId: delegation.parentGrantId,
        vector: childBudget.available,
        delegationId: delegation.delegationId,
        childRunId: child.runId,
        childGrantId: delegation.childGrantId,
        occurredAt: command.occurredAt
      };
      const facts: AgentControlCommitFacts = {
        ...EMPTY_AGENT_CONTROL_COMMIT_FACTS,
        budgetEntries: [releaseEntry],
        childTerminals: [terminalFact]
      };
      const mutation = createMutation(
        parent,
        nextParent,
        command.commandId,
        digest,
        command.occurredAt,
        [{
          type: 'child.terminal_observed',
          delegationId: delegation.delegationId,
          childRunId: child.runId,
          childRunVersion: child.version,
          childStatus: command.childStatus
        }],
        checkpointArtifacts(nextParent, command.occurredAt, {
          phase: nextParent.state.status,
          terminalChildRunIds
        })
      );
      return commitNew(transaction, command.commandId, digest, [mutation], facts);
    });
  }

  public async requestParentCancellation(
    input: RequestAgentParentCancellationCommand
  ): Promise<AgentControlCommandResult> {
    const command = snapshotParentCancellationCommand(input);
    const digest = await sha256AgentControlData(command);
    return this.unitOfWork.transaction(async (transaction) => {
      const replay = await loadExactReplay(
        transaction,
        command.commandId,
        digest,
        EMPTY_AGENT_CONTROL_COMMIT_FACTS
      );
      if (replay !== null) return replay;
      const parent = await requireExpectedRun(transaction, command);
      if (parent.state.status !== 'waiting_children') {
        throw new AgentRunInvariantError(
          'Parent cancellation coordination requires waiting_children state.'
        );
      }
      const delegations = await requireControl(transaction)
        .listDelegationsByParent(parent.runId);
      const required = delegations.filter((item) => item.required);
      const terminalChildRunIds = required
        .filter((item) => item.terminal !== null)
        .map((item) => item.childRunId)
        .sort(codeUnitCompare);
      const allTerminal = terminalChildRunIds.length === required.length;
      const state: AgentRunState = allTerminal
        ? {
            status: 'cancelled',
            checkpointVersion: parent.state.checkpointVersion + 1,
            cancelledAt: command.occurredAt,
            reason: command.reason
          }
        : {
            status: 'cancelling',
            checkpointVersion: parent.state.checkpointVersion + 1,
            requestedAt: command.occurredAt,
            reason: command.reason,
            requiredChildRunIds: required.map((item) => item.childRunId).sort(codeUnitCompare),
            terminalChildRunIds
          };
      const next: AgentRun = {
        ...parent,
        version: parent.version + 1,
        state,
        updatedAt: command.occurredAt
      };
      assertValidAgentRun(next);
      const mutation = createMutation(
        parent,
        next,
        command.commandId,
        digest,
        command.occurredAt,
        [{ type: 'run.cancellation_requested', reason: command.reason }],
        checkpointArtifacts(next, command.occurredAt, {
          phase: state.status,
          terminalChildRunIds
        })
      );
      return commitNew(
        transaction,
        command.commandId,
        digest,
        [mutation],
        EMPTY_AGENT_CONTROL_COMMIT_FACTS
      );
    });
  }

  private async applyBudgetMutation(
    command: ReserveAgentBudgetCommand | SettleAgentBudgetCommand | ReleaseAgentBudgetCommand
  ): Promise<AgentControlCommandResult> {
    const digest = await sha256AgentControlData(command);
    return this.unitOfWork.transaction(async (transaction) => {
      const committed = await transaction.loadCommittedCommand(command.commandId);
      if (committed !== null) return assertReplayDigest(committed, digest);
      const current = await requireExpectedRun(transaction, command);
      if (current.state.status !== 'running') {
        throw new AgentRunInvariantError(
          'Budget reservation changes require a running Run recovery boundary.'
        );
      }
      const snapshot = await requireControl(transaction)
        .loadBudgetSnapshot(current.binding.budget.grantId);
      requireBudgetSnapshot(current, snapshot);
      let entry: AgentBudgetLedgerEntryCommit;
      let event: AgentRunEventPayload;
      if (command.kind === 'control.budget.reserve') {
        if (Date.parse(command.occurredAt) > Date.parse(snapshot.grant.deadlineAt)) {
          throw new AgentRunInvariantError('Budget deadline has expired.');
        }
        if (isZeroAgentBudgetVector(command.vector)) {
          throw new AgentRunInvariantError('A Budget reservation cannot be zero.');
        }
        if (!agentBudgetVectorFits(command.vector, snapshot.available)) {
          throw new AgentRunInvariantError('Budget reservation exceeds the available vector.');
        }
        if (snapshot.openReservations.some((item) => item.reservationId === command.reservationId)) {
          throw new AgentRunInvariantError('Budget reservation identity already exists.');
        }
        entry = {
          kind: 'reservation',
          entryId: command.entryId,
          runId: command.runId,
          grantId: snapshot.grant.grantId,
          vector: command.vector,
          reservationId: command.reservationId,
          occurredAt: command.occurredAt
        };
        event = {
          type: 'budget.reserved',
          entryId: command.entryId,
          reservationId: command.reservationId
        };
      } else {
        const reservation = snapshot.openReservations.find(
          (item) => item.reservationId === command.reservationId
        );
        if (reservation === undefined) {
          throw new AgentRunInvariantError('Budget settlement requires an open reservation.');
        }
        if (
          command.kind === 'control.budget.settle'
          && !agentBudgetVectorFits(command.actual, reservation.vector)
        ) {
          throw new AgentRunInvariantError('Budget settlement exceeds its reservation.');
        }
        entry = command.kind === 'control.budget.settle'
          ? {
              kind: 'settlement',
              entryId: command.entryId,
              runId: command.runId,
              grantId: snapshot.grant.grantId,
              vector: command.actual,
              reservationId: command.reservationId,
              occurredAt: command.occurredAt
            }
          : {
              kind: 'release',
              entryId: command.entryId,
              runId: command.runId,
              grantId: snapshot.grant.grantId,
              vector: reservation.vector,
              reservationId: command.reservationId,
              occurredAt: command.occurredAt
            };
        event = {
          type: command.kind === 'control.budget.settle'
            ? 'budget.settled'
            : 'budget.released',
          entryId: command.entryId,
          reservationId: command.reservationId
        };
      }
      const facts: AgentControlCommitFacts = {
        ...EMPTY_AGENT_CONTROL_COMMIT_FACTS,
        budgetEntries: [entry]
      };
      const next = bumpRunningRun(current, command.occurredAt);
      const mutation = createMutation(
        current,
        next,
        command.commandId,
        digest,
        command.occurredAt,
        [event],
        checkpointArtifacts(next, command.occurredAt, {
          phase: event.type,
          reservationId: command.reservationId
        })
      );
      return commitNew(transaction, command.commandId, digest, [mutation], facts);
    });
  }
}

interface RequiredControlTransaction {
  loadPlanVersion(reference: AgentPlanReference): Promise<AgentPlanVersionCommit | null>;
  loadBudgetSnapshot(grantId: string): Promise<AgentBudgetSnapshot | null>;
  loadDelegationByChild(childRunId: string): Promise<AgentDelegationRecord | null>;
  listDelegationsByParent(parentRunId: string): Promise<readonly AgentDelegationRecord[]>;
  loadChildTerminal(delegationId: string): Promise<AgentChildTerminalCommit | null>;
}

function requireControl(transaction: AgentRunTransaction): RequiredControlTransaction {
  if (
    transaction.loadPlanVersion === undefined
    || transaction.loadBudgetSnapshot === undefined
    || transaction.loadDelegationByChild === undefined
    || transaction.listDelegationsByParent === undefined
    || transaction.loadChildTerminal === undefined
  ) {
    throw new AgentRunInvariantError(
      'The Agent Control UnitOfWork does not implement Plan/Budget/Delegation facts.'
    );
  }
  return {
    loadPlanVersion: transaction.loadPlanVersion.bind(transaction),
    loadBudgetSnapshot: transaction.loadBudgetSnapshot.bind(transaction),
    loadDelegationByChild: transaction.loadDelegationByChild.bind(transaction),
    listDelegationsByParent: transaction.listDelegationsByParent.bind(transaction),
    loadChildTerminal: transaction.loadChildTerminal.bind(transaction)
  };
}

async function requireExpectedRun(
  transaction: AgentRunTransaction,
  command: ControlCommandBase
): Promise<AgentRun> {
  const run = await transaction.loadRun(command.runId);
  if (run === null) throw new AgentRunNotFoundError(command.runId);
  if (run.version !== command.expectedVersion) {
    throw new AgentRunVersionConflictError(
      command.runId,
      command.expectedVersion,
      run.version
    );
  }
  return run;
}

async function loadExactReplay(
  transaction: AgentRunTransaction,
  commandId: string,
  digest: string,
  facts: AgentControlCommitFacts
): Promise<AgentControlCommandResult | null> {
  const committed = await transaction.loadCommittedCommand(commandId, undefined, facts);
  return committed === null ? null : assertReplayDigest(committed, digest);
}

function assertReplayDigest(
  committed: CommittedAgentRunCommand,
  digest: string
): AgentControlCommandResult {
  if (committed.commandDigest !== digest) {
    throw new AgentRunCommandConflictError(
      committed.commandId,
      committed.mutations.map((item) => item.runId).join(','),
      'control-command',
      'command_mismatch'
    );
  }
  return {
    commandId: committed.commandId,
    mutations: committed.mutations,
    replayed: true,
    idempotent: true
  };
}

async function commitNew(
  transaction: AgentRunTransaction,
  commandId: string,
  commandDigest: string,
  mutations: readonly AgentRunCommitMutation[],
  facts: AgentControlCommitFacts
): Promise<AgentControlCommandResult> {
  assertAgentControlCommitFacts(facts);
  const commit: AgentRunCommandCommit = {
    commandId,
    commandDigest,
    mutations,
    facts
  };
  await transaction.commitCommand(commit);
  return {
    commandId,
    mutations: mutations.map(({ expectedVersion: _expected, artifacts: _artifacts, ...item }) => item),
    replayed: false,
    idempotent: false
  };
}

function createMutation(
  current: AgentRun | null,
  run: AgentRun,
  commandId: string,
  commandDigest: string,
  occurredAt: string,
  payloads: readonly AgentRunEventPayload[],
  artifacts: AgentRunCommitArtifacts
): AgentRunCommitMutation {
  const events: AgentRunEvent[] = payloads.map((payload, index) => ({
    eventId: `event:${commandDigest.slice(7)}:${run.runId}:${String(index + 1)}`,
    commandId,
    runId: run.runId,
    runVersion: run.version,
    sequence: index + 1,
    occurredAt,
    payload
  }));
  return {
    runId: run.runId,
    expectedVersion: current?.version ?? null,
    resultingVersion: run.version,
    run,
    events,
    artifacts
  };
}

function checkpointArtifacts(
  run: AgentRun,
  createdAt: string,
  engineContinuation: unknown
): AgentRunCommitArtifacts {
  assertAgentControlJsonValue(engineContinuation, 'checkpoint.engineContinuation');
  return {
    checkpoint: {
      checkpointVersion: run.state.checkpointVersion,
      payload: {
        format: 'ariadne.agent-checkpoint',
        schemaVersion: 1,
        engineContinuation: engineContinuation as AgentControlJsonValue,
        modelContext: []
      },
      createdAt
    },
    turnInputPayloads: [],
    effectPayloads: []
  };
}

function bumpRunningRun(run: AgentRun, occurredAt: string): AgentRun {
  if (run.state.status !== 'running') {
    throw new AgentRunInvariantError('Only a running Run can mutate its Budget ledger.');
  }
  const next: AgentRun = {
    ...run,
    version: run.version + 1,
    state: {
      ...run.state,
      checkpointVersion: run.state.checkpointVersion + 1
    },
    updatedAt: occurredAt
  };
  assertValidAgentRun(next);
  return next;
}

function transitionParentAfterChildTerminal(
  parent: AgentRun,
  command: ObserveAgentChildTerminalCommand,
  terminalChildRunIds: readonly string[],
  allRequiredTerminal: boolean
): AgentRun {
  if (parent.state.status !== 'waiting_children' && parent.state.status !== 'cancelling') {
    throw new AgentRunInvariantError(
      'Child terminal propagation requires waiting_children or cancelling state.'
    );
  }
  let state: AgentRunState;
  if (parent.state.status === 'cancelling' && allRequiredTerminal) {
    state = {
      status: 'cancelled',
      checkpointVersion: parent.state.checkpointVersion + 1,
      cancelledAt: command.occurredAt,
      reason: parent.state.reason
    };
  } else if (parent.state.status === 'waiting_children' && allRequiredTerminal) {
    state = {
      status: 'running',
      checkpointVersion: parent.state.checkpointVersion + 1,
      enteredAt: command.occurredAt
    };
  } else {
    state = {
      ...parent.state,
      checkpointVersion: parent.state.checkpointVersion + 1,
      terminalChildRunIds
    };
  }
  const next: AgentRun = {
    ...parent,
    version: parent.version + 1,
    state,
    updatedAt: command.occurredAt
  };
  assertValidAgentRun(next);
  return next;
}

function requireDelegatableParent(parent: AgentRun): void {
  if (
    parent.state.status !== 'running'
    || parent.effects.some((effect) => !isTerminalEffect(effect))
    || parent.turns.some((turn) =>
      turn.attempts.some((attempt) => !isTerminalInferenceAttempt(attempt))
    )
  ) {
    throw new AgentRunInvariantError(
      'A parent may delegate only at a running checkpoint with no external I/O in flight.'
    );
  }
}

function requireBudgetSnapshot(
  run: AgentRun,
  snapshot: AgentBudgetSnapshot | null
): asserts snapshot is AgentBudgetSnapshot {
  if (
    snapshot === null
    || snapshot.grant.runId !== run.runId
    || snapshot.grant.grantId !== run.binding.budget.grantId
    || JSON.stringify(snapshot.grant.vector) !== JSON.stringify(run.binding.budget.vector)
    || snapshot.grant.deadlineAt !== run.binding.budget.deadlineAt
  ) {
    throw new AgentRunInvariantError('The durable Budget grant does not match the Run binding.');
  }
}

async function assertAllRequiredDescendantsTerminal(
  control: RequiredControlTransaction,
  parentRunId: string
): Promise<void> {
  const descendants = await control.listDelegationsByParent(parentRunId);
  if (descendants.some((item) => item.required && item.terminal === null)) {
    throw new AgentRunInvariantError(
      'A child with a non-terminal required descendant cannot propagate terminal state.'
    );
  }
}

function createDelegationFacts(
  command: DelegateAgentChildRunsCommand
): AgentControlCommitFacts {
  const delegations: AgentDelegationCommit[] = command.children.map((child) => {
    if (child.binding.objectiveRef.kind !== 'parent_delegation') {
      throw new AgentRunInvariantError('Child objective reference must be a parent delegation.');
    }
    return {
      delegationId: child.delegationId,
      parentRunId: command.runId,
      childRunId: child.runId,
      parentGrantId: child.binding.budget.source.kind === 'parent_allocation'
        ? child.binding.budget.source.parentGrantId
        : 'invalid',
      childGrantId: child.binding.budget.grantId,
      objectiveDigest: child.binding.objectiveRef.objectiveDigest,
      objective: child.objective,
      required: child.required,
      createdAt: command.occurredAt
    };
  }).sort((left, right) => codeUnitCompare(left.delegationId, right.delegationId));
  const budgetGrants = command.children.map((child) => ({
    grantId: child.binding.budget.grantId,
    runId: child.runId,
    vector: { ...child.binding.budget.vector },
    deadlineAt: child.binding.budget.deadlineAt,
    createdAt: command.occurredAt,
    source: child.binding.budget.source
  })).sort((left, right) => codeUnitCompare(left.grantId, right.grantId));
  const budgetEntries: AgentBudgetLedgerEntryCommit[] = command.children.map((child) => ({
    kind: 'parent_allocation' as const,
    entryId: `budget-entry:allocation:${child.delegationId}`,
    runId: command.runId,
    grantId: child.binding.budget.source.kind === 'parent_allocation'
      ? child.binding.budget.source.parentGrantId
      : 'invalid',
    vector: { ...child.binding.budget.vector },
    delegationId: child.delegationId,
    childRunId: child.runId,
    childGrantId: child.binding.budget.grantId,
    occurredAt: command.occurredAt
  })).sort((left, right) => codeUnitCompare(left.entryId, right.entryId));
  const facts: AgentControlCommitFacts = {
    ...EMPTY_AGENT_CONTROL_COMMIT_FACTS,
    budgetGrants,
    budgetEntries,
    delegations
  };
  assertAgentControlCommitFacts(facts);
  return facts;
}

function snapshotCreatePlanCommand(input: CreateAgentPlanVersionCommand): CreateAgentPlanVersionCommand {
  assertBaseCommand(input);
  assertCanonicalPublicId(input.decisionId, 'command.decisionId');
  assertAgentPlanReference(input.plan.ref, 'command.plan.ref');
  assertAgentControlJsonValue(input.plan.payload, 'command.plan.payload');
  return cloneJson(input);
}

function snapshotApprovePlanCommand(input: ApproveAgentPlanCommand): ApproveAgentPlanCommand {
  assertBaseCommand(input);
  assertCanonicalPublicId(input.approvalId, 'command.approvalId');
  assertCanonicalPublicId(input.decisionId, 'command.decisionId');
  assertPositiveInteger(input.checkpointVersion, 'command.checkpointVersion');
  assertAgentPlanReference(input.plan, 'command.plan');
  return cloneJson(input);
}

function snapshotReserveBudgetCommand(input: ReserveAgentBudgetCommand): ReserveAgentBudgetCommand {
  assertBaseCommand(input);
  assertCanonicalPublicId(input.entryId, 'command.entryId');
  assertCanonicalPublicId(input.reservationId, 'command.reservationId');
  assertAgentBudgetVector(input.vector, 'command.vector');
  return cloneJson(input);
}

function snapshotSettleBudgetCommand(input: SettleAgentBudgetCommand): SettleAgentBudgetCommand {
  assertBaseCommand(input);
  assertCanonicalPublicId(input.entryId, 'command.entryId');
  assertCanonicalPublicId(input.reservationId, 'command.reservationId');
  assertAgentBudgetVector(input.actual, 'command.actual');
  return cloneJson(input);
}

function snapshotReleaseBudgetCommand(input: ReleaseAgentBudgetCommand): ReleaseAgentBudgetCommand {
  assertBaseCommand(input);
  assertCanonicalPublicId(input.entryId, 'command.entryId');
  assertCanonicalPublicId(input.reservationId, 'command.reservationId');
  return cloneJson(input);
}

function snapshotDelegateChildrenCommand(
  input: DelegateAgentChildRunsCommand
): DelegateAgentChildRunsCommand {
  assertBaseCommand(input);
  if (!Array.isArray(input.children) || input.children.length === 0) {
    throw new AgentRunInvariantError('Delegation requires at least one child Run.');
  }
  let previousRunId: string | undefined;
  const children = input.children.map((child) => {
    assertCanonicalPublicId(child.delegationId, 'command.children.delegationId');
    assertCanonicalPublicId(child.runId, 'command.children.runId');
    if (previousRunId !== undefined && previousRunId >= child.runId) {
      throw new AgentRunInvariantError(
        'Delegated children must be strictly sorted by Run ID without duplicates.'
      );
    }
    previousRunId = child.runId;
    assertValidAgentRunBinding(child.binding);
    assertAgentControlJsonValue(child.objective, 'command.children.objective');
    if (typeof child.required !== 'boolean') {
      throw new AgentRunInvariantError('command.children.required must be boolean.');
    }
    return {
      delegationId: child.delegationId,
      runId: child.runId,
      binding: cloneAgentRunBinding(child.binding),
      objective: cloneAgentControlJsonValue(child.objective),
      required: child.required
    };
  });
  return { ...input, children };
}

function snapshotObserveChildTerminalCommand(
  input: ObserveAgentChildTerminalCommand
): ObserveAgentChildTerminalCommand {
  assertBaseCommand(input);
  assertCanonicalPublicId(input.childRunId, 'command.childRunId');
  assertPositiveInteger(input.childRunVersion, 'command.childRunVersion');
  if (!['completed', 'failed', 'cancelled'].includes(input.childStatus)) {
    throw new AgentRunInvariantError('command.childStatus must be terminal.');
  }
  return cloneJson(input);
}

function snapshotParentCancellationCommand(
  input: RequestAgentParentCancellationCommand
): RequestAgentParentCancellationCommand {
  assertBaseCommand(input);
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
    throw new AgentRunInvariantError('command.reason must be non-empty.');
  }
  return cloneJson(input);
}

function assertBaseCommand(command: ControlCommandBase): void {
  assertAgentControlJsonValue(command, 'command');
  assertCanonicalPublicId(command.commandId, 'command.commandId');
  assertCanonicalPublicId(command.runId, 'command.runId');
  assertPositiveInteger(command.expectedVersion, 'command.expectedVersion');
  assertTimestamp(command.occurredAt, 'command.occurredAt');
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

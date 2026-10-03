import { DatabaseSync } from 'node:sqlite';
import {
  AgentRunInvariantError,
  AgentRunRecoveryConflictError,
  assertAgentControlCommitFacts,
  addAgentBudgetVectors,
  subtractAgentBudgetVectors,
  zeroAgentBudgetVector,
  agentBudgetVectorFits,
  isZeroAgentBudgetVector,
  sha256AgentControlData,
  type AgentPersistencePayloadCodec,
  type AgentRun,
  type AgentRunCommandCommit,
  type AgentControlCommitFacts,
  type AgentBudgetGrantCommit,
  type AgentBudgetLedgerEntryCommit,
  type AgentBudgetSnapshot
} from '@ariadne/agent-core';
import {
  type AgentBudgetEntryRow,
  type AgentRunRow,
  type PreparedCommandFacts,
  type PreparedDelegationFact,
  type PreparedPlanVersionFact
} from './AgentControlStorageTypes.js';
import { encodePayload } from './AgentControlPayloadCodec.js';
import { canonicalJson, parseRunRow } from './AgentControlStorageValidation.js';
import { loadBudgetGrantRecord, loadBudgetSnapshotRecord } from './AgentControlFactReader.js';

export async function prepareCommandFacts(
  database: DatabaseSync,
  codec: AgentPersistencePayloadCodec,
  commit: AgentRunCommandCommit,
  facts: AgentControlCommitFacts
): Promise<PreparedCommandFacts> {
  assertAgentControlCommitFacts(facts);
  const mutationVersions = new Map(
    commit.mutations.map((mutation) => [mutation.runId, mutation.resultingVersion])
  );
  const mutationRuns = new Map(
    commit.mutations.map((mutation) => [mutation.runId, mutation.run])
  );
  const requireMutationVersion = (runId: string, source: string): number => {
    const version = mutationVersions.get(runId);
    if (version === undefined) {
      throw new AgentRunInvariantError(
        `${source} must bind a Run mutation in the same command.`
      );
    }
    return version;
  };

  const preparedPlanVersions: PreparedPlanVersionFact[] = [];
  for (const fact of facts.planVersions) {
    const runVersion = requireMutationVersion(fact.runId, 'Plan version');
    const existing = database.prepare(
      `SELECT 1 FROM agent_v3_plan_versions
       WHERE plan_id=? AND plan_version=?`
    ).get(fact.ref.planId, fact.ref.version);
    if (existing !== undefined) {
      throw new AgentRunInvariantError('An immutable Plan version already exists.');
    }
    if (await sha256AgentControlData(fact.payload) !== fact.ref.contentHash) {
      throw new AgentRunRecoveryConflictError(
        fact.runId,
        'immutable_payload_conflict',
        'Protected Plan payload does not match its exact content hash.'
      );
    }
    preparedPlanVersions.push({
      fact,
      runVersion,
      encoded: encodePayload(codec, fact.payload, {
        kind: 'plan_payload',
        runId: fact.runId,
        commandId: commit.commandId,
        runVersion,
        planId: fact.ref.planId,
        planVersion: fact.ref.version,
        contentHash: fact.ref.contentHash
      })
    });
  }

  for (const approval of facts.planApprovals) {
    const runVersion = requireMutationVersion(approval.runId, 'Plan approval');
    const run = mutationRuns.get(approval.runId);
    const persisted = database.prepare(
      `SELECT run_id, content_hash FROM agent_v3_plan_versions
       WHERE plan_id=? AND plan_version=?`
    ).get(approval.plan.planId, approval.plan.version) as {
      run_id: string;
      content_hash: string;
    } | undefined;
    const inCommand = facts.planVersions.find((item) =>
      item.ref.planId === approval.plan.planId
      && item.ref.version === approval.plan.version
    );
    if (
      run === undefined
      || runVersion !== run.version
      || (
        persisted === undefined
        && inCommand === undefined
      )
      || (persisted?.run_id ?? inCommand?.runId) !== approval.runId
      || (persisted?.content_hash ?? inCommand?.ref.contentHash)
        !== approval.plan.contentHash
    ) {
      throw new AgentRunInvariantError(
        'Plan approval must reference the exact immutable Plan and Run mutation.'
      );
    }
  }

  const knownGrantIds = new Set<string>();
  for (const grant of facts.budgetGrants) {
    requireMutationVersion(grant.runId, 'Budget grant');
    if (
      database.prepare('SELECT 1 FROM agent_v3_budget_grants WHERE grant_id=?')
        .get(grant.grantId) !== undefined
    ) {
      throw new AgentRunInvariantError('A Budget grant is immutable once created.');
    }
    const run = mutationRuns.get(grant.runId);
    if (
      run === undefined
      || run.binding.budget.grantId !== grant.grantId
      || run.binding.budget.runId !== grant.runId
      || canonicalJson(run.binding.budget.vector) !== canonicalJson(grant.vector)
      || run.binding.budget.deadlineAt !== grant.deadlineAt
      || canonicalJson(run.binding.budget.source) !== canonicalJson(grant.source)
    ) {
      throw new AgentRunInvariantError(
        'Budget grant must match the exact immutable Run binding.'
      );
    }
    knownGrantIds.add(grant.grantId);
  }

  const preparedDelegations: PreparedDelegationFact[] = [];
  for (const delegation of facts.delegations) {
    const parentRunVersion = requireMutationVersion(
      delegation.parentRunId,
      'Delegation parent'
    );
    const childRunVersion = requireMutationVersion(
      delegation.childRunId,
      'Delegation child'
    );
    const childRun = mutationRuns.get(delegation.childRunId);
    if (
      database.prepare(
        'SELECT 1 FROM agent_v3_delegations WHERE delegation_id=? OR child_run_id=?'
      ).get(delegation.delegationId, delegation.childRunId) !== undefined
      || childRun?.binding.objectiveRef.kind !== 'parent_delegation'
      || childRun.binding.objectiveRef.parentRunId !== delegation.parentRunId
      || childRun.binding.objectiveRef.delegationId !== delegation.delegationId
      || childRun.binding.objectiveRef.objectiveDigest !== delegation.objectiveDigest
      || childRun.binding.budget.grantId !== delegation.childGrantId
      || childRun.binding.budget.source.kind !== 'parent_allocation'
      || childRun.binding.budget.source.parentGrantId !== delegation.parentGrantId
      || childRun.binding.budget.source.delegationId !== delegation.delegationId
    ) {
      throw new AgentRunInvariantError(
        'Delegation must match the exact child binding and same-command Runs.'
      );
    }
    if (await sha256AgentControlData(delegation.objective) !== delegation.objectiveDigest) {
      throw new AgentRunRecoveryConflictError(
        delegation.childRunId,
        'immutable_payload_conflict',
        'Protected child objective does not match its exact digest.'
      );
    }
    preparedDelegations.push({
      fact: delegation,
      parentRunVersion,
      childRunVersion,
      encodedObjective: encodePayload(codec, delegation.objective, {
        kind: 'delegation_objective',
        runId: delegation.childRunId,
        commandId: commit.commandId,
        runVersion: childRunVersion,
        delegationId: delegation.delegationId,
        objectiveDigest: delegation.objectiveDigest
      })
    });
  }

  for (const terminal of facts.childTerminals) {
    requireMutationVersion(terminal.parentRunId, 'Child terminal parent');
    const delegation = database.prepare(
      `SELECT parent_run_id, child_run_id FROM agent_v3_delegations
       WHERE delegation_id=?`
    ).get(terminal.delegationId) as {
      parent_run_id: string;
      child_run_id: string;
    } | undefined;
    const inCommand = facts.delegations.find(
      (item) => item.delegationId === terminal.delegationId
    );
    const childRow = database.prepare(
      `SELECT 1 AS present FROM agent_v3_command_runs
       WHERE run_id=? AND resulting_version=?`
    ).get(terminal.childRunId, terminal.childRunVersion) as { present: number } | undefined;
    const childCurrent = database.prepare(
      `SELECT run_id, version, state_status, aggregate_json, created_at, updated_at
       FROM agent_v3_runs WHERE run_id=?`
    ).get(terminal.childRunId) as AgentRunRow | undefined;
    const child = childCurrent === undefined
      ? null
      : parseRunRow(childCurrent, 'agent_v3_runs');
    if (
      (delegation?.parent_run_id ?? inCommand?.parentRunId) !== terminal.parentRunId
      || (delegation?.child_run_id ?? inCommand?.childRunId) !== terminal.childRunId
      || child === null
      || child.version !== terminal.childRunVersion
      || child.state.status !== terminal.childStatus
      || childRow === undefined
    ) {
      throw new AgentRunInvariantError(
        'Child terminal fact must bind an exact historical terminal Run version.'
      );
    }
  }

  await assertBudgetFactsBalanced(database, facts, mutationRuns, knownGrantIds);

  return {
    commandId: commit.commandId,
    planVersions: preparedPlanVersions,
    planApprovals: facts.planApprovals,
    budgetGrants: facts.budgetGrants,
    budgetEntries: facts.budgetEntries,
    delegations: preparedDelegations,
    childTerminals: facts.childTerminals,
    mutationVersions
  };
}

async function assertBudgetFactsBalanced(
  database: DatabaseSync,
  facts: AgentControlCommitFacts,
  mutationRuns: ReadonlyMap<string, AgentRun>,
  _knownGrantIds: ReadonlySet<string>
): Promise<void> {
  const grants = new Map<string, AgentBudgetGrantCommit>();
  const states = new Map<string, MutableBudgetState>();
  for (const grant of facts.budgetGrants) {
    grants.set(grant.grantId, grant);
    states.set(grant.grantId, createNewBudgetState(grant));
    if (grant.source.kind === 'parent_allocation') {
      const source = grant.source;
      const parent = facts.budgetGrants.find(
        (item) => item.grantId === source.parentGrantId
      ) ?? loadBudgetGrantRecord(database, source.parentGrantId);
      if (parent === null || parent.runId !== source.parentRunId) {
        throw new AgentRunInvariantError('Child Budget grant has no exact parent grant.');
      }
    }
  }

  const stateFor = (grantId: string): MutableBudgetState => {
    const existing = states.get(grantId);
    if (existing !== undefined) return existing;
    const snapshot = loadBudgetSnapshotRecord(database, grantId);
    if (snapshot === null) {
      throw new AgentRunInvariantError('Budget ledger entry references a missing grant.');
    }
    const state = mutableBudgetState(snapshot);
    states.set(grantId, state);
    grants.set(grantId, snapshot.grant);
    return state;
  };

  const ordered = [...facts.budgetEntries].sort((left, right) => {
    const rank = budgetEntryRank(left.kind) - budgetEntryRank(right.kind);
    return rank !== 0 ? rank : left.entryId < right.entryId ? -1 : 1;
  });
  for (const entry of ordered) {
    if (
      database.prepare('SELECT 1 FROM agent_v3_budget_entries WHERE entry_id=?')
        .get(entry.entryId) !== undefined
    ) {
      throw new AgentRunInvariantError('Budget ledger entry IDs are immutable.');
    }
    const state = stateFor(entry.grantId);
    const grant = grants.get(entry.grantId)!;
    if (entry.runId !== grant.runId || !mutationRuns.has(entry.runId)) {
      throw new AgentRunInvariantError(
        'Budget ledger entry must bind its grant owner Run mutation.'
      );
    }
    switch (entry.kind) {
      case 'root_grant':
        if (
          grant.source.kind !== 'root'
          || canonicalJson(entry.vector) !== canonicalJson(grant.vector)
        ) {
          throw new AgentRunInvariantError('Root grant ledger entry must equal its grant.');
        }
        break;
      case 'parent_allocation': {
        if (!agentBudgetVectorFits(entry.vector, state.available)) {
          throw new AgentRunInvariantError('Sibling Budget allocation exceeds parent balance.');
        }
        const childGrant = grants.get(entry.childGrantId)
          ?? loadBudgetGrantRecord(database, entry.childGrantId);
        const delegation = facts.delegations.find(
          (item) => item.delegationId === entry.delegationId
        );
        if (
          childGrant === null
          || delegation === undefined
          || childGrant.runId !== entry.childRunId
          || canonicalJson(childGrant.vector) !== canonicalJson(entry.vector)
          || delegation.parentGrantId !== entry.grantId
          || delegation.childGrantId !== entry.childGrantId
        ) {
          throw new AgentRunInvariantError(
            'Parent allocation must match the exact child grant and Delegation.'
          );
        }
        state.available = subtractAgentBudgetVectors(
          state.available,
          entry.vector,
          'parent allocation'
        );
        state.allocated = addAgentBudgetVectors(state.allocated, entry.vector);
        break;
      }
      case 'reservation':
        if (
          isZeroAgentBudgetVector(entry.vector)
          || !agentBudgetVectorFits(entry.vector, state.available)
          || state.openReservations.has(entry.reservationId)
        ) {
          throw new AgentRunInvariantError('Budget reservation exceeds available balance.');
        }
        state.available = subtractAgentBudgetVectors(
          state.available,
          entry.vector,
          'reservation'
        );
        state.reserved = addAgentBudgetVectors(state.reserved, entry.vector);
        state.openReservations.set(entry.reservationId, entry.vector);
        break;
      case 'settlement': {
        const reserved = state.openReservations.get(entry.reservationId);
        if (reserved === undefined || !agentBudgetVectorFits(entry.vector, reserved)) {
          throw new AgentRunInvariantError('Budget settlement exceeds its reservation.');
        }
        state.reserved = subtractAgentBudgetVectors(state.reserved, reserved, 'settlement');
        state.spent = addAgentBudgetVectors(state.spent, entry.vector);
        state.available = addAgentBudgetVectors(
          state.available,
          subtractAgentBudgetVectors(reserved, entry.vector, 'settlement remainder')
        );
        state.openReservations.delete(entry.reservationId);
        break;
      }
      case 'release': {
        const reserved = state.openReservations.get(entry.reservationId);
        if (reserved === undefined || canonicalJson(reserved) !== canonicalJson(entry.vector)) {
          throw new AgentRunInvariantError('Budget release must match its exact reservation.');
        }
        state.reserved = subtractAgentBudgetVectors(state.reserved, reserved, 'release');
        state.available = addAgentBudgetVectors(state.available, reserved);
        state.openReservations.delete(entry.reservationId);
        break;
      }
      case 'child_release': {
        const allocation = database.prepare(
          `SELECT * FROM agent_v3_budget_entries
           WHERE grant_id=? AND delegation_id=? AND entry_kind='parent_allocation'`
        ).get(entry.grantId, entry.delegationId) as AgentBudgetEntryRow | undefined;
        const terminal = facts.childTerminals.find(
          (item) => item.delegationId === entry.delegationId
        );
        const childSnapshot = loadBudgetSnapshotRecord(database, entry.childGrantId);
        if (
          allocation === undefined
          || terminal === undefined
          || childSnapshot === null
          || childSnapshot.openReservations.length > 0
          || canonicalJson(entry.vector) !== canonicalJson(childSnapshot.available)
          || !agentBudgetVectorFits(entry.vector, state.allocated)
        ) {
          throw new AgentRunInvariantError(
            'Child release requires an exact terminal child with no open reservation.'
          );
        }
        state.allocated = subtractAgentBudgetVectors(
          state.allocated,
          entry.vector,
          'child release'
        );
        state.available = addAgentBudgetVectors(state.available, entry.vector);
        break;
      }
    }
  }
}

interface MutableBudgetState {
  available: AgentBudgetSnapshot['available'];
  reserved: AgentBudgetSnapshot['reserved'];
  spent: AgentBudgetSnapshot['spent'];
  allocated: AgentBudgetSnapshot['allocated'];
  readonly openReservations: Map<string, AgentBudgetSnapshot['available']>;
}

function createNewBudgetState(grant: AgentBudgetGrantCommit): MutableBudgetState {
  return {
    available: { ...grant.vector },
    reserved: zeroAgentBudgetVector(),
    spent: zeroAgentBudgetVector(),
    allocated: zeroAgentBudgetVector(),
    openReservations: new Map()
  };
}

function mutableBudgetState(snapshot: AgentBudgetSnapshot): MutableBudgetState {
  return {
    available: { ...snapshot.available },
    reserved: { ...snapshot.reserved },
    spent: { ...snapshot.spent },
    allocated: { ...snapshot.allocated },
    openReservations: new Map(snapshot.openReservations.map((item) => [
      item.reservationId,
      { ...item.vector }
    ]))
  };
}

function budgetEntryRank(kind: AgentBudgetLedgerEntryCommit['kind']): number {
  switch (kind) {
    case 'root_grant': return 0;
    case 'parent_allocation': return 1;
    case 'reservation': return 2;
    case 'settlement':
    case 'release': return 3;
    case 'child_release': return 4;
  }
}

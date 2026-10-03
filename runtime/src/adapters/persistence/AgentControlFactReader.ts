import { DatabaseSync } from 'node:sqlite';
import {
  AgentRunCommandConflictError,
  assertAgentControlCommitFacts,
  countAgentControlCommitFacts,
  addAgentBudgetVectors,
  subtractAgentBudgetVectors,
  zeroAgentBudgetVector,
  agentBudgetVectorFits,
  sha256AgentControlData,
  type AgentPersistencePayloadCodec,
  type AgentControlCommitFacts,
  type AgentBudgetGrantCommit,
  type AgentBudgetLedgerEntryCommit,
  type AgentBudgetSnapshot,
  type AgentDelegationRecord,
  type AgentChildTerminalCommit
} from '@ariadne/agent-core';
import { canonicalJson, storageCorruption } from './AgentControlStorageValidation.js';
import {
  type AgentBudgetEntryRow,
  type AgentBudgetGrantRow,
  type AgentChildTerminalRow,
  type AgentDelegationRow,
  type AgentPlanVersionRow
} from './AgentControlStorageTypes.js';
import { decodePayload } from './AgentControlPayloadCodec.js';

export async function assertPersistedFactsMatchCommand(
  database: DatabaseSync,
  codec: AgentPersistencePayloadCodec,
  commandId: string,
  expected: AgentControlCommitFacts
): Promise<void> {
  assertAgentControlCommitFacts(expected);
  const actual = await loadPersistedCommandFacts(database, codec, commandId);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new AgentRunCommandConflictError(
      commandId,
      `facts:${String(countAgentControlCommitFacts(actual))}`,
      `facts:${String(countAgentControlCommitFacts(expected))}`,
      'command_mismatch'
    );
  }
}

async function loadPersistedCommandFacts(
  database: DatabaseSync,
  codec: AgentPersistencePayloadCodec,
  commandId: string
): Promise<AgentControlCommitFacts> {
  const planRows = database.prepare(
    'SELECT * FROM agent_v3_plan_versions WHERE command_id=? ORDER BY plan_id, plan_version'
  ).all(commandId) as unknown as AgentPlanVersionRow[];
  const planVersions = await Promise.all(planRows.map(async (row) => {
    const payload = decodePayload(codec, row.codec_id, row.payload_json, {
      kind: 'plan_payload',
      runId: row.run_id,
      commandId: row.command_id,
      runVersion: row.run_version,
      planId: row.plan_id,
      planVersion: row.plan_version,
      contentHash: row.content_hash
    }, `agent_v3_plan_versions:${row.plan_id}:${String(row.plan_version)}`);
    if (await sha256AgentControlData(payload) !== row.content_hash) {
      throw storageCorruption('plan_payload_hash_mismatch');
    }
    return {
      ref: {
        planId: row.plan_id,
        version: row.plan_version,
        contentHash: row.content_hash
      },
      runId: row.run_id,
      payload,
      createdAt: row.created_at
    };
  }));
  const approvalRows = database.prepare(
    `SELECT approval_id, decision_id, run_id, checkpoint_version,
            plan_id, plan_version, content_hash, approved_at
     FROM agent_v3_plan_approvals WHERE command_id=? ORDER BY approval_id`
  ).all(commandId) as unknown as Array<{
    approval_id: string;
    decision_id: string;
    run_id: string;
    checkpoint_version: number;
    plan_id: string;
    plan_version: number;
    content_hash: string;
    approved_at: string;
  }>;
  const grantRows = database.prepare(
    'SELECT * FROM agent_v3_budget_grants WHERE command_id=? ORDER BY grant_id'
  ).all(commandId) as unknown as AgentBudgetGrantRow[];
  const entryRows = database.prepare(
    'SELECT * FROM agent_v3_budget_entries WHERE command_id=? ORDER BY entry_id'
  ).all(commandId) as unknown as AgentBudgetEntryRow[];
  const delegationRows = database.prepare(
    'SELECT * FROM agent_v3_delegations WHERE command_id=? ORDER BY delegation_id'
  ).all(commandId) as unknown as AgentDelegationRow[];
  const terminalRows = database.prepare(
    'SELECT * FROM agent_v3_child_terminals WHERE command_id=? ORDER BY delegation_id'
  ).all(commandId) as unknown as AgentChildTerminalRow[];
  const delegations = await Promise.all(delegationRows.map(async (row) => {
    const decoded = await decodeDelegationRecord(database, codec, row);
    return {
      delegationId: decoded.delegationId,
      parentRunId: decoded.parentRunId,
      childRunId: decoded.childRunId,
      parentGrantId: decoded.parentGrantId,
      childGrantId: decoded.childGrantId,
      objectiveDigest: decoded.objectiveDigest,
      objective: decoded.objective,
      required: decoded.required,
      createdAt: decoded.createdAt
    };
  }));
  const facts: AgentControlCommitFacts = {
    planVersions,
    planApprovals: approvalRows.map((row) => ({
      approvalId: row.approval_id,
      decisionId: row.decision_id,
      runId: row.run_id,
      checkpointVersion: row.checkpoint_version,
      plan: {
        planId: row.plan_id,
        version: row.plan_version,
        contentHash: row.content_hash
      },
      approvedAt: row.approved_at
    })),
    budgetGrants: grantRows.map(parseBudgetGrantRow),
    budgetEntries: entryRows.map(parseBudgetEntryRow),
    delegations,
    childTerminals: terminalRows.map(parseChildTerminalRow)
  };
  assertAgentControlCommitFacts(facts);
  return facts;
}

export function countPersistedCommandFacts(database: DatabaseSync, commandId: string): number {
  const row = database.prepare(
    `SELECT
       (SELECT COUNT(*) FROM agent_v3_plan_versions WHERE command_id=?)
       + (SELECT COUNT(*) FROM agent_v3_plan_approvals WHERE command_id=?)
       + (SELECT COUNT(*) FROM agent_v3_budget_grants WHERE command_id=?)
       + (SELECT COUNT(*) FROM agent_v3_budget_entries WHERE command_id=?)
       + (SELECT COUNT(*) FROM agent_v3_delegations WHERE command_id=?)
       + (SELECT COUNT(*) FROM agent_v3_child_terminals WHERE command_id=?) AS count`
  ).get(commandId, commandId, commandId, commandId, commandId, commandId) as {
    count: number;
  };
  return Number(row.count);
}

export function loadBudgetGrantRecord(
  database: DatabaseSync,
  grantId: string
): AgentBudgetGrantCommit | null {
  const row = database.prepare(
    'SELECT * FROM agent_v3_budget_grants WHERE grant_id=?'
  ).get(grantId) as AgentBudgetGrantRow | undefined;
  return row === undefined ? null : parseBudgetGrantRow(row);
}

export function loadBudgetSnapshotRecord(
  database: DatabaseSync,
  grantId: string
): AgentBudgetSnapshot | null {
  const grant = loadBudgetGrantRecord(database, grantId);
  if (grant === null) return null;
  const rows = database.prepare(
    `SELECT * FROM agent_v3_budget_entries
     WHERE grant_id=? ORDER BY occurred_at, entry_id`
  ).all(grantId) as unknown as AgentBudgetEntryRow[];
  let spent = zeroAgentBudgetVector();
  let allocated = zeroAgentBudgetVector();
  const reservations = new Map<string, AgentBudgetSnapshot['available']>();
  let rootEntries = 0;
  const releasedDelegations = new Set<string>();
  const allocatedDelegations = new Map<string, AgentBudgetSnapshot['available']>();
  for (const row of rows) {
    const entry = parseBudgetEntryRow(row);
    switch (entry.kind) {
      case 'root_grant':
        rootEntries += 1;
        if (canonicalJson(entry.vector) !== canonicalJson(grant.vector)) {
          throw storageCorruption(`agent_v3_budget_entries:${entry.entryId}:root_mismatch`);
        }
        break;
      case 'parent_allocation':
        if (allocatedDelegations.has(entry.delegationId)) {
          throw storageCorruption(`agent_v3_budget_entries:${entry.entryId}:duplicate_allocation`);
        }
        allocatedDelegations.set(entry.delegationId, entry.vector);
        allocated = addAgentBudgetVectors(allocated, entry.vector);
        break;
      case 'reservation':
        if (reservations.has(entry.reservationId)) {
          throw storageCorruption(`agent_v3_budget_entries:${entry.entryId}:duplicate_reservation`);
        }
        reservations.set(entry.reservationId, entry.vector);
        break;
      case 'settlement': {
        const reserved = reservations.get(entry.reservationId);
        if (reserved === undefined || !agentBudgetVectorFits(entry.vector, reserved)) {
          throw storageCorruption(`agent_v3_budget_entries:${entry.entryId}:settlement_mismatch`);
        }
        reservations.delete(entry.reservationId);
        spent = addAgentBudgetVectors(spent, entry.vector);
        break;
      }
      case 'release': {
        const reserved = reservations.get(entry.reservationId);
        if (reserved === undefined || canonicalJson(reserved) !== canonicalJson(entry.vector)) {
          throw storageCorruption(`agent_v3_budget_entries:${entry.entryId}:release_mismatch`);
        }
        reservations.delete(entry.reservationId);
        break;
      }
      case 'child_release': {
        const allocation = allocatedDelegations.get(entry.delegationId);
        if (
          allocation === undefined
          || releasedDelegations.has(entry.delegationId)
          || !agentBudgetVectorFits(entry.vector, allocation)
        ) {
          throw storageCorruption(`agent_v3_budget_entries:${entry.entryId}:child_release_mismatch`);
        }
        releasedDelegations.add(entry.delegationId);
        allocated = subtractAgentBudgetVectors(allocated, entry.vector, 'persisted child release');
        break;
      }
    }
  }
  if (grant.source.kind === 'root' && rootEntries !== 1) {
    throw storageCorruption(`agent_v3_budget_grants:${grantId}:root_entry_missing`);
  }
  if (grant.source.kind === 'parent_allocation' && rootEntries !== 0) {
    throw storageCorruption(`agent_v3_budget_grants:${grantId}:unexpected_root_entry`);
  }
  let reserved = zeroAgentBudgetVector();
  for (const vector of reservations.values()) {
    reserved = addAgentBudgetVectors(reserved, vector);
  }
  let available: AgentBudgetSnapshot['available'];
  try {
    available = subtractAgentBudgetVectors(
      subtractAgentBudgetVectors(
        subtractAgentBudgetVectors(grant.vector, spent, 'persisted spend'),
        reserved,
        'persisted reservations'
      ),
      allocated,
      'persisted allocations'
    );
  } catch (error) {
    throw storageCorruption(`agent_v3_budget_grants:${grantId}:overdrawn`, error);
  }
  return {
    grant,
    available,
    reserved,
    spent,
    allocated,
    openReservations: [...reservations.entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([reservationId, vector]) => ({ reservationId, vector }))
  };
}

function parseBudgetGrantRow(row: AgentBudgetGrantRow): AgentBudgetGrantCommit {
  const vector = budgetVectorFromRow(row);
  const source: AgentBudgetGrantCommit['source'] = row.source_kind === 'root'
    ? { kind: 'root' }
    : {
        kind: 'parent_allocation',
        parentRunId: requireStoredText(row.parent_run_id, 'parent_run_id'),
        parentGrantId: requireStoredText(row.parent_grant_id, 'parent_grant_id'),
        delegationId: requireStoredText(row.delegation_id, 'delegation_id')
      };
  return {
    grantId: row.grant_id,
    runId: row.run_id,
    vector,
    deadlineAt: row.deadline_at,
    createdAt: row.created_at,
    source
  };
}

function parseBudgetEntryRow(row: AgentBudgetEntryRow): AgentBudgetLedgerEntryCommit {
  const base = {
    entryId: row.entry_id,
    runId: row.run_id,
    grantId: row.grant_id,
    vector: budgetVectorFromRow(row),
    occurredAt: row.occurred_at
  };
  switch (row.entry_kind) {
    case 'root_grant':
      return { ...base, kind: 'root_grant' };
    case 'reservation':
    case 'settlement':
    case 'release':
      return {
        ...base,
        kind: row.entry_kind,
        reservationId: requireStoredText(row.reservation_id, 'reservation_id')
      };
    case 'parent_allocation':
    case 'child_release':
      return {
        ...base,
        kind: row.entry_kind,
        delegationId: requireStoredText(row.delegation_id, 'delegation_id'),
        childRunId: requireStoredText(row.child_run_id, 'child_run_id'),
        childGrantId: requireStoredText(row.child_grant_id, 'child_grant_id')
      };
  }
}

function budgetVectorFromRow(row: {
  model_turns: number;
  tool_calls: number;
  read_calls: number;
  write_calls: number;
  shell_calls: number;
  cost_microusd: number;
}): AgentBudgetSnapshot['available'] {
  return {
    modelTurns: row.model_turns,
    toolCalls: row.tool_calls,
    readCalls: row.read_calls,
    writeCalls: row.write_calls,
    shellCalls: row.shell_calls,
    costMicrousd: row.cost_microusd
  };
}

export async function decodeDelegationRecord(
  database: DatabaseSync,
  codec: AgentPersistencePayloadCodec,
  row: AgentDelegationRow
): Promise<AgentDelegationRecord> {
  const objective = decodePayload(
    codec,
    row.objective_codec_id,
    row.objective_payload_json,
    {
      kind: 'delegation_objective',
      runId: row.child_run_id,
      commandId: row.command_id,
      runVersion: row.child_run_version,
      delegationId: row.delegation_id,
      objectiveDigest: row.objective_digest
    },
    `agent_v3_delegations:${row.delegation_id}`
  );
  if (await sha256AgentControlData(objective) !== row.objective_digest) {
    throw storageCorruption(`agent_v3_delegations:${row.delegation_id}:objective_hash_mismatch`);
  }
  const terminalRow = database.prepare(
    'SELECT * FROM agent_v3_child_terminals WHERE delegation_id=?'
  ).get(row.delegation_id) as AgentChildTerminalRow | undefined;
  return {
    delegationId: row.delegation_id,
    parentRunId: row.parent_run_id,
    childRunId: row.child_run_id,
    parentGrantId: row.parent_grant_id,
    childGrantId: row.child_grant_id,
    objectiveDigest: row.objective_digest,
    objective,
    required: row.required === 1,
    createdAt: row.created_at,
    terminal: terminalRow === undefined ? null : parseChildTerminalRow(terminalRow)
  };
}

export function parseChildTerminalRow(row: AgentChildTerminalRow): AgentChildTerminalCommit {
  return {
    delegationId: row.delegation_id,
    parentRunId: row.parent_run_id,
    childRunId: row.child_run_id,
    childRunVersion: row.child_run_version,
    childStatus: row.child_status,
    observedAt: row.observed_at
  };
}

function requireStoredText(value: string | null, field: string): string {
  if (value === null || value.length === 0) {
    throw storageCorruption(`stored_fact:${field}:missing`);
  }
  return value;
}

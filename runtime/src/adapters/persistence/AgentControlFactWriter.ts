import { DatabaseSync } from 'node:sqlite';
import { AgentRunInvariantError } from '@ariadne/agent-core';
import {
  type PreparedCommandFacts,
  type PreparedDelegationFact,
  type PreparedEncodedPayload,
  type PreparedPlanVersionFact
} from './AgentControlStorageTypes.js';

export function persistPreparedCommandFacts(
  database: DatabaseSync,
  prepared: PreparedCommandFacts
): void {
  const insertPlan = database.prepare(
    `INSERT INTO agent_v3_plan_versions (
       plan_id, plan_version, content_hash, run_id, run_version,
       command_id, codec_id, payload_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const item of prepared.planVersions) {
    insertPlan.run(
      item.fact.ref.planId,
      item.fact.ref.version,
      item.fact.ref.contentHash,
      item.fact.runId,
      item.runVersion,
      prepared.commandId,
      item.encoded.codecId,
      item.encoded.payloadJson,
      item.fact.createdAt
    );
  }

  const insertApproval = database.prepare(
    `INSERT INTO agent_v3_plan_approvals (
       approval_id, decision_id, run_id, checkpoint_version,
       plan_id, plan_version, content_hash, command_id, run_version, approved_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const approval of prepared.planApprovals) {
    insertApproval.run(
      approval.approvalId,
      approval.decisionId,
      approval.runId,
      approval.checkpointVersion,
      approval.plan.planId,
      approval.plan.version,
      approval.plan.contentHash,
      prepared.commandId,
      requirePreparedMutationVersion(prepared, approval.runId),
      approval.approvedAt
    );
  }

  const insertGrant = database.prepare(
    `INSERT INTO agent_v3_budget_grants (
       grant_id, run_id, model_turns, tool_calls, read_calls, write_calls,
       shell_calls, cost_microusd, deadline_at, source_kind,
       parent_run_id, parent_grant_id, delegation_id,
       command_id, run_version, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const grant of prepared.budgetGrants) {
    const source = grant.source;
    insertGrant.run(
      grant.grantId,
      grant.runId,
      grant.vector.modelTurns,
      grant.vector.toolCalls,
      grant.vector.readCalls,
      grant.vector.writeCalls,
      grant.vector.shellCalls,
      grant.vector.costMicrousd,
      grant.deadlineAt,
      source.kind,
      source.kind === 'parent_allocation' ? source.parentRunId : null,
      source.kind === 'parent_allocation' ? source.parentGrantId : null,
      source.kind === 'parent_allocation' ? source.delegationId : null,
      prepared.commandId,
      requirePreparedMutationVersion(prepared, grant.runId),
      grant.createdAt
    );
  }

  const insertEntry = database.prepare(
    `INSERT INTO agent_v3_budget_entries (
       entry_id, command_id, run_id, run_version, grant_id, entry_kind,
       model_turns, tool_calls, read_calls, write_calls, shell_calls,
       cost_microusd, reservation_id, delegation_id, child_run_id,
       child_grant_id, occurred_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const entry of prepared.budgetEntries) {
    insertEntry.run(
      entry.entryId,
      prepared.commandId,
      entry.runId,
      requirePreparedMutationVersion(prepared, entry.runId),
      entry.grantId,
      entry.kind,
      entry.vector.modelTurns,
      entry.vector.toolCalls,
      entry.vector.readCalls,
      entry.vector.writeCalls,
      entry.vector.shellCalls,
      entry.vector.costMicrousd,
      'reservationId' in entry ? entry.reservationId : null,
      'delegationId' in entry ? entry.delegationId : null,
      'childRunId' in entry ? entry.childRunId : null,
      'childGrantId' in entry ? entry.childGrantId : null,
      entry.occurredAt
    );
  }

  const insertDelegation = database.prepare(
    `INSERT INTO agent_v3_delegations (
       delegation_id, parent_run_id, child_run_id,
       parent_grant_id, child_grant_id, objective_digest,
       objective_codec_id, objective_payload_json, required,
       command_id, parent_run_version, child_run_version, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const item of prepared.delegations) {
    insertDelegation.run(
      item.fact.delegationId,
      item.fact.parentRunId,
      item.fact.childRunId,
      item.fact.parentGrantId,
      item.fact.childGrantId,
      item.fact.objectiveDigest,
      item.encodedObjective.codecId,
      item.encodedObjective.payloadJson,
      item.fact.required ? 1 : 0,
      prepared.commandId,
      item.parentRunVersion,
      item.childRunVersion,
      item.fact.createdAt
    );
  }

  const insertTerminal = database.prepare(
    `INSERT INTO agent_v3_child_terminals (
       delegation_id, parent_run_id, child_run_id, child_run_version,
       child_status, command_id, parent_run_version, observed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const terminal of prepared.childTerminals) {
    insertTerminal.run(
      terminal.delegationId,
      terminal.parentRunId,
      terminal.childRunId,
      terminal.childRunVersion,
      terminal.childStatus,
      prepared.commandId,
      requirePreparedMutationVersion(prepared, terminal.parentRunId),
      terminal.observedAt
    );
  }
}

function requirePreparedMutationVersion(
  prepared: PreparedCommandFacts,
  runId: string
): number {
  const version = prepared.mutationVersions.get(runId);
  if (version === undefined) {
    throw new AgentRunInvariantError('Prepared control fact lost its Run mutation.');
  }
  return version;
}

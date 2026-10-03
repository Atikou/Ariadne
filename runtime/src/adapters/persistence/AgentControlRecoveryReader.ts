import { DatabaseSync } from 'node:sqlite';
import {
  assertAgentTurnInputSnapshotMatchesTurn,
  sha256AgentControlData,
  type AgentDirectivePayloadCommit,
  type AgentTurnInputPayloadReference,
  type AgentPersistencePayloadCodec,
  type AgentRun,
  type AgentRunRecoveryPage,
  type AgentRunRecoveryQueryRequest,
  type AgentEffectPayloadReference,
  type BlockedAgentRunRecovery,
  type RecoverableAgentRun
} from '@ariadne/agent-core';
import { decodeDelegationRecord, loadBudgetSnapshotRecord } from './AgentControlFactReader.js';
import {
  canonicalJson,
  parseRunRow,
  storageCorruption
} from './AgentControlStorageValidation.js';
import {
  type AgentCheckpointMetadataRow,
  type AgentCheckpointRow,
  type AgentDelegationRow,
  type AgentDirectivePayloadRow,
  type AgentEffectPayloadMetadataRow,
  type AgentPlanVersionRow,
  type AgentRunRow,
  type AgentTurnInputPayloadRow
} from './AgentControlStorageTypes.js';
import { decodePayload, decodeTurnInputColumn } from './AgentControlPayloadCodec.js';
import {
  checkpointCoversInboxOnlyAdvance,
  checkpointReference,
  loadTurnInputPayload
} from './AgentControlPayloadReader.js';

async function collectControlRecoveryIssues(
  database: DatabaseSync,
  codec: AgentPersistencePayloadCodec,
  run: AgentRun
): Promise<Set<BlockedAgentRunRecovery['issues'][number]>> {
  const issues = new Set<BlockedAgentRunRecovery['issues'][number]>();
  try {
    const budget = loadBudgetSnapshotRecord(database, run.binding.budget.grantId);
    if (budget === null) {
      issues.add('missing_budget_grant');
    } else if (
      budget.grant.runId !== run.runId
      || canonicalJson(budget.grant.vector) !== canonicalJson(run.binding.budget.vector)
      || budget.grant.deadlineAt !== run.binding.budget.deadlineAt
      || canonicalJson(budget.grant.source) !== canonicalJson(run.binding.budget.source)
    ) {
      issues.add('budget_integrity_mismatch');
    }
  } catch {
    issues.add('budget_integrity_mismatch');
  }

  if (run.binding.objectiveRef.kind === 'parent_delegation') {
    const row = database.prepare(
      'SELECT * FROM agent_v3_delegations WHERE child_run_id=?'
    ).get(run.runId) as AgentDelegationRow | undefined;
    if (row === undefined) {
      issues.add('missing_delegation');
    } else {
      try {
        const delegation = await decodeDelegationRecord(database, codec, row);
        if (
          delegation.parentRunId !== run.binding.objectiveRef.parentRunId
          || delegation.delegationId !== run.binding.objectiveRef.delegationId
          || delegation.objectiveDigest !== run.binding.objectiveRef.objectiveDigest
          || delegation.childGrantId !== run.binding.budget.grantId
        ) {
          issues.add('delegation_integrity_mismatch');
        }
      } catch {
        issues.add('delegation_integrity_mismatch');
      }
    }
  }

  if (
    run.state.status === 'waiting'
    && run.state.reason === 'plan_approval'
  ) {
    const decision = run.state.decision;
    const row = database.prepare(
      `SELECT * FROM agent_v3_plan_versions
       WHERE plan_id=? AND plan_version=?`
    ).get(decision.planId, decision.planVersion) as AgentPlanVersionRow | undefined;
    if (row === undefined) {
      issues.add('missing_plan_payload');
    } else {
      try {
        const payload = decodePayload(codec, row.codec_id, row.payload_json, {
          kind: 'plan_payload',
          runId: row.run_id,
          commandId: row.command_id,
          runVersion: row.run_version,
          planId: row.plan_id,
          planVersion: row.plan_version,
          contentHash: row.content_hash
        }, `agent_v3_plan_versions:${row.plan_id}:${String(row.plan_version)}`);
        if (
          row.run_id !== run.runId
          || row.content_hash !== decision.planHash
          || await sha256AgentControlData(payload) !== decision.planHash
        ) {
          issues.add('plan_integrity_mismatch');
        }
      } catch {
        issues.add('plan_integrity_mismatch');
      }
    }
  }

  for (const turn of run.turns) {
    for (const attempt of turn.attempts) {
      if (attempt.state.status !== 'succeeded') continue;
      const directive = attempt.state.directive;
      let expected: {
        artifactId: string;
        kind: AgentDirectivePayloadCommit['kind'];
        contentDigest: string;
      } | null = null;
      if (directive.kind === 'respond') {
        expected = {
          artifactId: directive.contentRef,
          kind: 'response_content',
          contentDigest: directive.contentDigest
        };
      } else if (directive.kind === 'ask_user') {
        expected = {
          artifactId: directive.questionRef,
          kind: 'user_question',
          contentDigest: directive.questionDigest
        };
      } else if (directive.kind === 'checkpoint') {
        expected = {
          artifactId: directive.reasonRef,
          kind: 'checkpoint_reason',
          contentDigest: directive.reasonDigest
        };
      } else if (
        directive.kind === 'complete'
        && directive.outputRef !== undefined
        && directive.outputDigest !== undefined
      ) {
        expected = {
          artifactId: directive.outputRef,
          kind: 'completion_output',
          contentDigest: directive.outputDigest
        };
      } else if (directive.kind === 'fail') {
        expected = {
          artifactId: directive.messageRef,
          kind: 'failure_message',
          contentDigest: directive.messageDigest
        };
      }
      if (expected === null) continue;
      const row = database.prepare(
        'SELECT * FROM agent_v3_directive_payloads WHERE artifact_id=?'
      ).get(expected.artifactId) as AgentDirectivePayloadRow | undefined;
      if (row === undefined) {
        issues.add('missing_directive_payload');
        continue;
      }
      try {
        const payload = decodePayload(codec, row.codec_id, row.payload_json, {
          kind: 'directive_response',
          runId: row.run_id,
          commandId: row.command_id,
          runVersion: row.run_version,
          directiveDigest: row.directive_digest,
          contentHash: row.content_digest
        }, `agent_v3_directive_payloads:${row.artifact_id}`);
        if (
          row.run_id !== run.runId
          || row.payload_kind !== expected.kind
          || row.directive_digest !== attempt.state.directiveDigest
          || row.content_digest !== expected.contentDigest
          || await sha256AgentControlData(payload) !== expected.contentDigest
        ) {
          issues.add('directive_payload_mismatch');
        }
      } catch {
        issues.add('directive_payload_mismatch');
      }
    }
  }

  if (run.state.status === 'waiting_children' || run.state.status === 'cancelling') {
    try {
      const rows = database.prepare(
        `SELECT * FROM agent_v3_delegations
         WHERE parent_run_id=? ORDER BY child_run_id`
      ).all(run.runId) as unknown as AgentDelegationRow[];
      const required = rows.filter((row) => row.required === 1).map((row) => row.child_run_id);
      const terminal = rows.filter((row) =>
        row.required === 1
        && database.prepare(
          'SELECT 1 FROM agent_v3_child_terminals WHERE delegation_id=?'
        ).get(row.delegation_id) !== undefined
      ).map((row) => row.child_run_id);
      if (
        canonicalJson(required) !== canonicalJson(run.state.requiredChildRunIds)
        || canonicalJson(terminal) !== canonicalJson(run.state.terminalChildRunIds)
      ) {
        issues.add('pending_required_child_mismatch');
      }
    } catch {
      issues.add('pending_required_child_mismatch');
    }
  }
  return issues;
}

export async function loadActiveRuns(
  database: DatabaseSync,
  codec: AgentPersistencePayloadCodec,
  request: AgentRunRecoveryQueryRequest
): Promise<AgentRunRecoveryPage> {
  assertActiveRunMetadataConsistent(database);
  const limit = request.limit ?? 100;
  const parameters: Array<string | number> = [];
  let cursorClause = '';
  if (request.after !== undefined) {
    cursorClause = 'AND (created_at > ? OR (created_at = ? AND run_id > ?))';
    parameters.push(
      request.after.createdAt,
      request.after.createdAt,
      request.after.runId
    );
  }
  parameters.push(limit + 1);
  const rows = database.prepare(
    `SELECT run_id, version, state_status, aggregate_json,
            created_at, updated_at
     FROM agent_v3_runs
     WHERE state_status IN (
       'queued', 'running', 'waiting', 'recovering',
       'waiting_children', 'waiting_input', 'cancelling'
     )
       ${cursorClause}
     ORDER BY created_at, run_id
     LIMIT ?`
  ).all(...parameters) as unknown as AgentRunRow[];
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const items: RecoverableAgentRun[] = [];
  for (const row of pageRows) {
    const run = parseRunRow(row, 'agent_v3_runs');
    const controlIssues = await collectControlRecoveryIssues(database, codec, run);
    if (run.state.status === 'queued') {
      const recoveryRows = database.prepare(
        `SELECT
           (SELECT COUNT(*) FROM agent_v3_checkpoints WHERE run_id=?)
             +
           (SELECT COUNT(*) FROM agent_v3_effect_payloads WHERE run_id=?) AS other_count,
           (SELECT COUNT(*) FROM agent_v3_turn_inputs WHERE run_id=?) AS turn_input_count`
      ).get(run.runId, run.runId, run.runId) as {
        other_count: number;
        turn_input_count: number;
      };
      if (
        recoveryRows.other_count === 0
        && recoveryRows.turn_input_count === 0
        && controlIssues.size === 0
      ) {
        items.push({
          ready: true,
          phase: 'queued',
          run,
          checkpoint: null,
          turnInputPayloads: [],
          effectPayloads: []
        });
      } else {
        items.push({
          ready: false,
          run,
          issues: [
            ...(recoveryRows.other_count === 0 ? [] : ['unexpected_checkpoint'] as const),
            ...(recoveryRows.turn_input_count === 0
              ? []
              : ['unexpected_turn_input'] as const),
            ...controlIssues
          ]
        });
      }
      continue;
    }

    const issues = new Set<BlockedAgentRunRecovery['issues'][number]>(controlIssues);
    const checkpoint = database.prepare(
      `SELECT run_id, checkpoint_version, run_version, command_id, created_at
       FROM agent_v3_checkpoints
       WHERE run_id=? AND checkpoint_version=?`
    ).get(run.runId, run.state.checkpointVersion) as
      AgentCheckpointMetadataRow | undefined;
    if (checkpoint === undefined) {
      issues.add('missing_checkpoint');
    } else if (
      checkpoint.run_version !== run.version
      && !checkpointCoversInboxOnlyAdvance(database, run, checkpoint.run_version)
    ) {
      issues.add('checkpoint_metadata_mismatch');
    }


    const turnInputRows = database.prepare(
      'SELECT * FROM agent_v3_turn_inputs WHERE run_id=? ORDER BY turn_id'
    ).all(run.runId) as unknown as AgentTurnInputPayloadRow[];
    const turnInputReferences: AgentTurnInputPayloadReference[] = [];
    for (const turn of run.turns) {
      const payload = turnInputRows.find((candidate) => candidate.turn_id === turn.turnId);
      if (payload === undefined) {
        issues.add('missing_turn_input');
        continue;
      }
      const expectedIntroductionVersion = (turn.intention.expectedRunVersion ?? 0) + 1;
      if (
        payload.input_digest !== turn.intention.inputDigest
        || payload.created_at !== turn.createdAt
        || payload.run_version !== expectedIntroductionVersion
      ) {
        issues.add('turn_input_digest_mismatch');
        continue;
      }
      const reference: AgentTurnInputPayloadReference = {
        runId: payload.run_id,
        turnId: payload.turn_id,
        inputDigest: payload.input_digest,
        commandId: payload.command_id,
        runVersion: payload.run_version,
        createdAt: payload.created_at
      };
      try {
        const decoded = decodeTurnInputColumn(codec, payload);
        await assertAgentTurnInputSnapshotMatchesTurn(
          run,
          turn.turnId,
          turn.intention.inputDigest,
          decoded
        );
        await loadTurnInputPayload(database, codec, reference);
        turnInputReferences.push(reference);
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        issues.add(message.includes('turn_input_cause_mismatch')
          ? 'turn_input_cause_mismatch'
          : message.includes('turn_input_catalog_mismatch')
            ? 'turn_input_catalog_mismatch'
            : 'turn_input_digest_mismatch');
      }
    }
    if (turnInputRows.some((payload) =>
      !run.turns.some((turn) => turn.turnId === payload.turn_id)
    )) {
      issues.add('unexpected_turn_input');
    }

    const effectRows = database.prepare(
      `SELECT run_id, effect_id, input_digest,
              input_command_id, input_run_version,
              result_command_id, result_run_version,
              CASE WHEN result_payload_json IS NULL THEN 0 ELSE 1 END AS has_result,
              created_at, updated_at
       FROM agent_v3_effect_payloads
       WHERE run_id=? ORDER BY effect_id`
    ).all(run.runId) as unknown as AgentEffectPayloadMetadataRow[];
    const effectReferences: AgentEffectPayloadReference[] = [];
    for (const effect of run.effects) {
      const payload = effectRows.find((candidate) => candidate.effect_id === effect.effectId);
      if (payload === undefined) {
        issues.add('missing_effect_input');
        continue;
      }
      if (payload.input_digest !== effect.inputDigest) {
        issues.add('effect_digest_mismatch');
      }
      const expectsResult = effect.state.status === 'succeeded'
        || effect.state.status === 'failed';
      const hasResult = payload.has_result === 1;
      if (expectsResult && !hasResult) issues.add('missing_effect_result');
      if (!expectsResult && hasResult) issues.add('unexpected_effect_result');
      if (hasResult) {
        if (payload.result_command_id === null || payload.result_run_version === null) {
          issues.add('missing_effect_result');
          continue;
        }
        effectReferences.push({
          runId: run.runId,
          effectId: effect.effectId,
          inputDigest: payload.input_digest,
          inputCommandId: payload.input_command_id,
          inputRunVersion: payload.input_run_version,
          hasResult: true,
          resultCommandId: payload.result_command_id,
          resultRunVersion: payload.result_run_version,
          createdAt: payload.created_at,
          updatedAt: payload.updated_at
        });
      } else {
        effectReferences.push({
          runId: run.runId,
          effectId: effect.effectId,
          inputDigest: payload.input_digest,
          inputCommandId: payload.input_command_id,
          inputRunVersion: payload.input_run_version,
          hasResult: false,
          createdAt: payload.created_at,
          updatedAt: payload.updated_at
        });
      }
    }
    if (effectRows.some((payload) =>
      !run.effects.some((effect) => effect.effectId === payload.effect_id)
    )) {
      throw storageCorruption(`agent_v3_effect_payloads:${run.runId}:orphaned_effect`);
    }

    if (issues.size > 0 || checkpoint === undefined) {
      items.push({ ready: false, run, issues: [...issues] });
    } else {
      items.push({
        ready: true,
        phase: 'resumable',
        run,
        checkpoint: checkpointReference(checkpoint),
        turnInputPayloads: turnInputReferences,
        effectPayloads: effectReferences
      });
    }
  }
  const last = pageRows.at(-1);
  return {
    items,
    ...(hasMore && last !== undefined
      ? {
          nextCursor: {
            createdAt: last.created_at,
            runId: last.run_id
          }
        }
      : {})
  };
}

function assertActiveRunMetadataConsistent(database: DatabaseSync): void {
  const row = database.prepare(
    `SELECT run_id
     FROM agent_v3_runs
     WHERE (
       state_status IN (
         'queued', 'running', 'waiting', 'recovering',
         'waiting_children', 'waiting_input', 'cancelling'
       )
       OR json_extract(aggregate_json, '$.state.status')
          IN (
            'queued', 'running', 'waiting', 'recovering',
            'waiting_children', 'waiting_input', 'cancelling'
          )
     )
       AND (
         state_status IS NOT json_extract(aggregate_json, '$.state.status')
         OR created_at IS NOT json_extract(aggregate_json, '$.createdAt')
         OR updated_at IS NOT json_extract(aggregate_json, '$.updatedAt')
       )
     LIMIT 1`
  ).get() as { run_id: string } | undefined;
  if (row !== undefined) {
    throw storageCorruption(`agent_v3_runs:${row.run_id}:recovery_metadata_mismatch`);
  }
}

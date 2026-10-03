import { DatabaseSync } from 'node:sqlite';
import {
  AgentRunInvariantError,
  AgentRunRecoveryConflictError,
  AgentRunVersionConflictError,
  assertAgentRunCommitArtifacts,
  assertAgentRunCommitArtifactDigests,
  assertAgentTurnInputSnapshotMatchesTurn,
  sha256AgentControlData,
  type AgentEffectInputDigester,
  type AgentJsonValue,
  type AgentPersistencePayloadCodec,
  type AgentPersistencePayloadContext,
  type AgentRun,
  type AgentRunCommandCommit,
  type AgentRunCommitMutation
} from '@ariadne/agent-core';
import {
  type AgentEffectPayloadRow,
  type AgentRunRow,
  type AgentTurnInputPayloadRow,
  type PreparedCommandMutation,
  type PreparedDirectiveArtifact,
  type PreparedEffectArtifact,
  type PreparedTurnInputArtifact
} from './AgentControlStorageTypes.js';
import { assertStableRunIdentity, parseRunRow } from './AgentControlStorageValidation.js';
import {
  assertDurableEffectResultContinuationArtifacts,
  checkpointCoversInboxOnlyAdvance,
  loadTurnInputPayload
} from './AgentControlPayloadReader.js';
import {
  encodePayload,
  loadEffectPayloadRow,
  loadTurnInputPayloadRow
} from './AgentControlPayloadCodec.js';

export async function prepareCommandMutations(
  database: DatabaseSync,
  codec: AgentPersistencePayloadCodec,
  effectInputDigester: AgentEffectInputDigester,
  commit: AgentRunCommandCommit
): Promise<readonly PreparedCommandMutation[]> {
  const prepared: PreparedCommandMutation[] = [];
  for (const mutation of commit.mutations) {
    const currentRow = database.prepare(
      `SELECT run_id, version, state_status, aggregate_json,
              created_at, updated_at
       FROM agent_v3_runs WHERE run_id=?`
    ).get(mutation.runId) as AgentRunRow | undefined;
    const current = currentRow === undefined
      ? null
      : parseRunRow(currentRow, 'agent_v3_runs');
    const actualVersion = current?.version ?? null;
    if (actualVersion !== mutation.expectedVersion) {
      throw new AgentRunVersionConflictError(
        mutation.runId,
        mutation.expectedVersion,
        actualVersion
      );
    }
    const expectedNextVersion = (actualVersion ?? 0) + 1;
    if (
      mutation.resultingVersion !== expectedNextVersion
      || mutation.run.version !== expectedNextVersion
    ) {
      throw new AgentRunInvariantError(
        'Every persisted AgentRun version must advance exactly once.'
      );
    }
    if (current !== null) {
      assertStableRunIdentity(current, mutation.run);
      assertRecoveryMaterialComplete(database, current);
      await assertStoredTurnInputsComplete(database, codec, current);
    }
    const artifacts = mutation.artifacts;
    assertAgentRunCommitArtifacts(current, mutation.run, artifacts);
    await assertAgentRunCommitArtifactDigests(current, mutation.run, artifacts);
    await assertDurableEffectResultContinuationArtifacts(
      database,
      codec,
      mutation.run,
      artifacts,
      mutation.expectedVersion
    );

    const checkpoint = artifacts.checkpoint;
    const preparedCheckpoint = checkpoint === undefined
      ? undefined
      : {
          checkpointVersion: checkpoint.checkpointVersion,
          createdAt: checkpoint.createdAt,
          encoded: encodePayload(codec, checkpoint.payload, {
            kind: 'checkpoint',
            runId: mutation.runId,
            commandId: commit.commandId,
            runVersion: mutation.resultingVersion,
            checkpointVersion: checkpoint.checkpointVersion
          })
        };
    const turnInputs: PreparedTurnInputArtifact[] = [];
    for (const payload of artifacts.turnInputPayloads) {
      if (loadTurnInputPayloadRow(database, mutation.runId, payload.turnId) !== undefined) {
        throw new AgentRunRecoveryConflictError(
          mutation.runId,
          'immutable_payload_conflict',
          `Turn input "${payload.turnId}" is already durable.`
        );
      }
      turnInputs.push({
        payload,
        encoded: encodePayload(
          codec,
          payload.payload as unknown as AgentJsonValue,
          {
            kind: 'turn_input',
            runId: mutation.runId,
            turnId: payload.turnId,
            commandId: commit.commandId,
            runVersion: mutation.resultingVersion,
            inputDigest: payload.inputDigest
          }
        )
      });
    }
    const effects: PreparedEffectArtifact[] = [];
    for (const payload of artifacts.effectPayloads) {
      const context: AgentPersistencePayloadContext = {
        kind: payload.kind === 'record_input' ? 'effect_input' : 'effect_result',
        runId: mutation.runId,
        commandId: commit.commandId,
        runVersion: mutation.resultingVersion,
        effectId: payload.effectId,
        inputDigest: payload.inputDigest
      };
      if (payload.kind === 'record_input') {
        const actualDigest = effectInputDigester.digest(payload.input, {
          runId: mutation.runId,
          effectId: payload.effectId
        });
        if (actualDigest !== payload.inputDigest) {
          throw new AgentRunRecoveryConflictError(
            mutation.runId,
            'effect_digest_mismatch',
            `Effect payload "${payload.effectId}" does not match its protected input digest.`
          );
        }
        if (loadEffectPayloadRow(database, mutation.runId, payload.effectId) !== undefined) {
          throw new AgentRunRecoveryConflictError(
            mutation.runId,
            'immutable_payload_conflict',
            `Effect input "${payload.effectId}" is already durable.`
          );
        }
        effects.push({ payload, encoded: encodePayload(codec, payload.input, context) });
        continue;
      }
      const currentPayload = loadEffectPayloadRow(
        database,
        mutation.runId,
        payload.effectId
      );
      if (currentPayload === undefined || currentPayload.input_digest !== payload.inputDigest) {
        throw new AgentRunRecoveryConflictError(
          mutation.runId,
          'effect_digest_mismatch',
          `Effect result "${payload.effectId}" has no matching persisted input.`
        );
      }
      if (currentPayload.result_command_id !== null) {
        throw new AgentRunRecoveryConflictError(
          mutation.runId,
          'immutable_payload_conflict',
          `Effect result "${payload.effectId}" is immutable once recorded.`
        );
      }
      effects.push({ payload, encoded: encodePayload(codec, payload.result, context) });
    }
    const directives: PreparedDirectiveArtifact[] = [];
    for (const payload of artifacts.directivePayloads ?? []) {
      if (
        database.prepare(
          'SELECT 1 FROM agent_v3_directive_payloads WHERE artifact_id=?'
        ).get(payload.artifactId) !== undefined
      ) {
        throw new AgentRunRecoveryConflictError(
          mutation.runId,
          'immutable_payload_conflict',
          `Directive artifact "${payload.artifactId}" is already durable.`
        );
      }
      if (await sha256AgentControlData(payload.payload) !== payload.contentDigest) {
        throw new AgentRunRecoveryConflictError(
          mutation.runId,
          'immutable_payload_conflict',
          `Directive artifact "${payload.artifactId}" content digest does not match.`
        );
      }
      directives.push({
        payload,
        encoded: encodePayload(codec, payload.payload, {
          kind: 'directive_response',
          runId: mutation.runId,
          commandId: commit.commandId,
          runVersion: mutation.resultingVersion,
          directiveDigest: payload.directiveDigest,
          contentHash: payload.contentDigest
        })
      });
    }
    assertPreparedRecoveryMaterialComplete(database, mutation, turnInputs, effects);
    prepared.push({
      mutation,
      currentRow,
      ...(preparedCheckpoint === undefined ? {} : { checkpoint: preparedCheckpoint }),
      turnInputs,
      effects,
      directives
    });
  }
  return prepared;
}

function assertPreparedRecoveryMaterialComplete(
  database: DatabaseSync,
  mutation: AgentRunCommitMutation,
  preparedTurnInputs: readonly PreparedTurnInputArtifact[],
  preparedEffects: readonly PreparedEffectArtifact[]
): void {
  const preparedTurnIds = new Set(
    preparedTurnInputs.map((item) => item.payload.turnId)
  );
  for (const turn of mutation.run.turns) {
    const persisted = loadTurnInputPayloadRow(database, mutation.runId, turn.turnId);
    if (
      persisted === undefined
        ? !preparedTurnIds.has(turn.turnId)
        : persisted.input_digest !== turn.intention.inputDigest
    ) {
      throw new AgentRunRecoveryConflictError(
        mutation.runId,
        'immutable_payload_conflict',
        `Turn "${turn.turnId}" does not have an exact protected input.`
      );
    }
  }
  const preparedByEffectId = new Map(
    preparedEffects.map((item) => [item.payload.effectId, item.payload] as const)
  );
  for (const effect of mutation.run.effects) {
    const persisted = loadEffectPayloadRow(database, mutation.runId, effect.effectId);
    const prepared = preparedByEffectId.get(effect.effectId);
    const hasInput = persisted !== undefined || prepared?.kind === 'record_input';
    const inputDigest = persisted?.input_digest ?? prepared?.inputDigest;
    if (!hasInput || inputDigest !== effect.inputDigest) {
      throw new AgentRunRecoveryConflictError(
        mutation.runId,
        'effect_digest_mismatch',
        `Effect "${effect.effectId}" does not have an exact durable input.`
      );
    }
    const requiresResult = effect.state.status === 'succeeded'
      || effect.state.status === 'failed';
    const hasResult = persisted?.result_payload_json !== null
      && persisted?.result_payload_json !== undefined
      || prepared?.kind === 'record_result';
    if (requiresResult !== hasResult) {
      throw new AgentRunRecoveryConflictError(
        mutation.runId,
        'immutable_payload_conflict',
        `Effect "${effect.effectId}" has inconsistent durable result material.`
      );
    }
  }
}

function assertRecoveryMaterialComplete(database: DatabaseSync, run: AgentRun): void {
  if (
    run.state.status !== 'queued'
    && run.state.status !== 'completed'
    && run.state.status !== 'failed'
    && run.state.status !== 'cancelled'
  ) {
    const checkpoint = database.prepare(
      `SELECT run_version FROM agent_v3_checkpoints
       WHERE run_id=? AND checkpoint_version=?`
    ).get(run.runId, run.state.checkpointVersion) as { run_version: number } | undefined;
    if (
      checkpoint === undefined
      || (
        checkpoint.run_version !== run.version
        && !checkpointCoversInboxOnlyAdvance(database, run, checkpoint.run_version)
      )
    ) {
      throw new AgentRunRecoveryConflictError(
        run.runId,
        'checkpoint_mismatch',
        'The active run does not have an exact durable checkpoint.'
      );
    }
  }
  for (const effect of run.effects) {
    const payload = loadEffectPayloadRow(database, run.runId, effect.effectId);
    if (payload === undefined || payload.input_digest !== effect.inputDigest) {
      throw new AgentRunRecoveryConflictError(
        run.runId,
        'effect_digest_mismatch',
        `Effect "${effect.effectId}" does not have a matching durable input.`
      );
    }
    const requiresResult = effect.state.status === 'succeeded'
      || effect.state.status === 'failed';
    if (requiresResult !== (payload.result_payload_json !== null)) {
      throw new AgentRunRecoveryConflictError(
        run.runId,
        'immutable_payload_conflict',
        `Effect "${effect.effectId}" has inconsistent durable result material.`
      );
    }
  }
}

async function assertStoredTurnInputsComplete(
  database: DatabaseSync,
  codec: AgentPersistencePayloadCodec,
  run: AgentRun
): Promise<void> {
  const rows = database.prepare(
    'SELECT * FROM agent_v3_turn_inputs WHERE run_id=? ORDER BY turn_id'
  ).all(run.runId) as unknown as AgentTurnInputPayloadRow[];
  if (run.state.status === 'queued') {
    if (run.turns.length !== 0 || rows.length !== 0) {
      throw new AgentRunRecoveryConflictError(
        run.runId,
        'immutable_payload_conflict',
        'A queued Run must not contain Turn input snapshots.'
      );
    }
    return;
  }
  if (rows.length !== run.turns.length) {
    throw new AgentRunRecoveryConflictError(
      run.runId,
      'immutable_payload_conflict',
      'Every existing Turn requires one exact protected input snapshot.'
    );
  }
  for (const turn of run.turns) {
    const row = rows.find((candidate) => candidate.turn_id === turn.turnId);
    if (row === undefined || row.input_digest !== turn.intention.inputDigest) {
      throw new AgentRunRecoveryConflictError(
        run.runId,
        'immutable_payload_conflict',
        `Turn "${turn.turnId}" has missing or drifted protected input metadata.`
      );
    }
    try {
      const snapshot = await loadTurnInputPayload(database, codec, {
        runId: row.run_id,
        turnId: row.turn_id,
        inputDigest: row.input_digest,
        commandId: row.command_id,
        runVersion: row.run_version,
        createdAt: row.created_at
      });
      await assertAgentTurnInputSnapshotMatchesTurn(
        run,
        turn.turnId,
        turn.intention.inputDigest,
        snapshot
      );
    } catch (error) {
      throw new AgentRunRecoveryConflictError(
        run.runId,
        'immutable_payload_conflict',
        `Turn "${turn.turnId}" protected input failed integrity validation: ${
          error instanceof Error ? error.name : 'unknown_error'
        }.`
      );
    }
  }
}

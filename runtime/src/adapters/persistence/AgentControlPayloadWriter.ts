import { DatabaseSync } from 'node:sqlite';
import { AgentRunRecoveryConflictError } from '@ariadne/agent-core';
import {
  type PreparedCommandMutation,
  type PreparedDirectiveArtifact,
  type PreparedEffectArtifact,
  type PreparedEncodedPayload,
  type PreparedTurnInputArtifact
} from './AgentControlStorageTypes.js';

export function persistPreparedCommitArtifacts(
  database: DatabaseSync,
  prepared: PreparedCommandMutation
): void {
  const mutation = prepared.mutation;
  const checkpoint = prepared.checkpoint;
  if (checkpoint !== undefined) {
    database.prepare(
      `INSERT INTO agent_v3_checkpoints (
         run_id, checkpoint_version, run_version, command_id,
         codec_id, payload_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      mutation.runId,
      checkpoint.checkpointVersion,
      mutation.resultingVersion,
      prepared.mutation.events[0]!.commandId,
      checkpoint.encoded.codecId,
      checkpoint.encoded.payloadJson,
      checkpoint.createdAt
    );
  }

  const commandId = mutation.events[0]!.commandId;
  const insertTurnInput = database.prepare(
    `INSERT INTO agent_v3_turn_inputs (
       run_id, turn_id, input_digest, command_id, run_version,
       codec_id, payload_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const item of prepared.turnInputs) {
    insertTurnInput.run(
      mutation.runId,
      item.payload.turnId,
      item.payload.inputDigest,
      commandId,
      mutation.resultingVersion,
      item.encoded.codecId,
      item.encoded.payloadJson,
      item.payload.recordedAt
    );
  }
  for (const item of prepared.effects) {
    const payload = item.payload;
    if (payload.kind === 'record_input') {
      database.prepare(
        `INSERT INTO agent_v3_effect_payloads (
           run_id, effect_id, input_digest,
           input_command_id, input_run_version,
           input_codec_id, input_payload_json,
           result_command_id, result_run_version,
           result_codec_id, result_payload_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`
      ).run(
        mutation.runId,
        payload.effectId,
        payload.inputDigest,
        commandId,
        mutation.resultingVersion,
        item.encoded.codecId,
        item.encoded.payloadJson,
        payload.recordedAt,
        payload.recordedAt
      );
      continue;
    }
    const update = database.prepare(
      `UPDATE agent_v3_effect_payloads
       SET result_command_id=?, result_run_version=?,
           result_codec_id=?, result_payload_json=?, updated_at=?
       WHERE run_id=? AND effect_id=? AND result_command_id IS NULL`
    ).run(
      commandId,
      mutation.resultingVersion,
      item.encoded.codecId,
      item.encoded.payloadJson,
      payload.recordedAt,
      mutation.runId,
      payload.effectId
    );
    if (Number(update.changes) !== 1) {
      throw new AgentRunRecoveryConflictError(
        mutation.runId,
        'immutable_payload_conflict',
        `Effect result "${payload.effectId}" was concurrently recorded.`
      );
    }
  }
  const insertDirective = database.prepare(
    `INSERT INTO agent_v3_directive_payloads (
       artifact_id, run_id, command_id, run_version, payload_kind,
       directive_digest, content_digest, codec_id, payload_json, recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const item of prepared.directives) {
    insertDirective.run(
      item.payload.artifactId,
      mutation.runId,
      commandId,
      mutation.resultingVersion,
      item.payload.kind,
      item.payload.directiveDigest,
      item.payload.contentDigest,
      item.encoded.codecId,
      item.encoded.payloadJson,
      item.payload.recordedAt
    );
  }
}

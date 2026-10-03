import { DatabaseSync } from 'node:sqlite';
import {
  AgentRunInvariantError,
  type AgentJsonValue,
  type AgentTurnInputSnapshotV1,
  type AgentPersistencePayloadCodec,
  type AgentPersistencePayloadContext
} from '@ariadne/agent-core';
import { type AgentEffectPayloadRow, type AgentTurnInputPayloadRow } from './AgentControlStorageTypes.js';
import {
  assertJsonValue,
  parseJson,
  serializeJson,
  storageCorruption
} from './AgentControlStorageValidation.js';

export function loadEffectPayloadRow(
  database: DatabaseSync,
  runId: string,
  effectId: string
): AgentEffectPayloadRow | undefined {
  return database.prepare(
    `SELECT * FROM agent_v3_effect_payloads WHERE run_id=? AND effect_id=?`
  ).get(runId, effectId) as AgentEffectPayloadRow | undefined;
}

export function loadTurnInputPayloadRow(
  database: DatabaseSync,
  runId: string,
  turnId: string
): AgentTurnInputPayloadRow | undefined {
  return database.prepare(
    'SELECT * FROM agent_v3_turn_inputs WHERE run_id=? AND turn_id=?'
  ).get(runId, turnId) as AgentTurnInputPayloadRow | undefined;
}

export function encodePayload(
  codec: AgentPersistencePayloadCodec,
  value: AgentJsonValue,
  context: AgentPersistencePayloadContext
): { codecId: string; payloadJson: string } {
  const encoded = codec.encode(value, context);
  if (encoded.codecId.length === 0) {
    throw new AgentRunInvariantError('Persistence payload codec IDs must be non-empty.');
  }
  assertJsonValue(encoded.payload, 'encoded.payload');
  return { codecId: encoded.codecId, payloadJson: serializeJson(encoded.payload) };
}

export function decodePayload(
  codec: AgentPersistencePayloadCodec,
  codecId: string,
  payloadJson: string,
  context: AgentPersistencePayloadContext,
  source: string
): AgentJsonValue {
  try {
    const encoded = parseJson(payloadJson, source);
    assertJsonValue(encoded, `${source}.payload`);
    const decoded = codec.decode({ codecId, payload: encoded }, context);
    assertJsonValue(decoded, `${source}.decoded`);
    return decoded;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('agent_v3_storage_corruption:')) {
      throw error;
    }
    throw storageCorruption(`${source}:payload_decode_failed`, error);
  }
}

export function decodeEffectColumn(
  codec: AgentPersistencePayloadCodec,
  row: AgentEffectPayloadRow,
  column: 'input' | 'result'
): AgentJsonValue {
  const isInput = column === 'input';
  const commandId = isInput ? row.input_command_id : row.result_command_id;
  const runVersion = isInput ? row.input_run_version : row.result_run_version;
  const codecId = isInput ? row.input_codec_id : row.result_codec_id;
  const payloadJson = isInput ? row.input_payload_json : row.result_payload_json;
  if (commandId === null || runVersion === null || codecId === null || payloadJson === null) {
    throw storageCorruption(
      `agent_v3_effect_payloads:${row.run_id}:${row.effect_id}:${column}_missing`
    );
  }
  return decodePayload(codec, codecId, payloadJson, {
    kind: isInput ? 'effect_input' : 'effect_result',
    runId: row.run_id,
    commandId,
    runVersion,
    effectId: row.effect_id,
    inputDigest: row.input_digest
  }, `agent_v3_effect_payloads:${row.run_id}:${row.effect_id}:${column}`);
}

export function decodeTurnInputColumn(
  codec: AgentPersistencePayloadCodec,
  row: AgentTurnInputPayloadRow
): AgentTurnInputSnapshotV1 {
  const decoded = decodePayload(codec, row.codec_id, row.payload_json, {
    kind: 'turn_input',
    runId: row.run_id,
    turnId: row.turn_id,
    commandId: row.command_id,
    runVersion: row.run_version,
    inputDigest: row.input_digest
  }, `agent_v3_turn_inputs:${row.run_id}:${row.turn_id}`);
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw storageCorruption(
      `agent_v3_turn_inputs:${row.run_id}:${row.turn_id}:invalid_payload`
    );
  }
  return decoded as unknown as AgentTurnInputSnapshotV1;
}

import { DatabaseSync } from 'node:sqlite';
import { AGENT_CONTROL_METADATA_KEYS } from './agentControlDbSchema.js';
import {
  type AgentControlMetadataRow,
  type AgentKeyringAnchorVerification,
  type AgentPersistenceClock,
  type ProtectedRecoveryPayloadRow
} from './AgentControlStorageTypes.js';

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export async function verifyOrInitializeKeyringAnchor(
  database: DatabaseSync,
  request: AgentKeyringAnchorVerification,
  clock: AgentPersistenceClock
): Promise<void> {
  const rows = database.prepare(
    `SELECT key, value FROM agent_control_metadata
     WHERE key IN (?, ?)
     ORDER BY key`
  ).all(
    AGENT_CONTROL_METADATA_KEYS.activeKeyId,
    AGENT_CONTROL_METADATA_KEYS.keyringGeneration
  ) as unknown as AgentControlMetadataRow[];

  if (rows.length === 0) {
    const counts = database.prepare(
      `SELECT
         (SELECT COUNT(*) FROM agent_v3_runs) AS runs,
         (SELECT COUNT(*) FROM agent_v3_checkpoints) AS checkpoints,
         (SELECT COUNT(*) FROM agent_v3_turn_inputs) AS turn_inputs,
         (SELECT COUNT(*) FROM agent_v3_effect_payloads) AS effect_payloads,
         (SELECT COUNT(*) FROM agent_v3_directive_payloads) AS directive_payloads,
         (SELECT COUNT(*) FROM agent_v3_plan_versions) AS plan_versions,
         (SELECT COUNT(*) FROM agent_v3_delegations) AS delegations`
    ).get() as {
      runs: number;
      checkpoints: number;
      turn_inputs: number;
      effect_payloads: number;
      directive_payloads: number;
      plan_versions: number;
      delegations: number;
    };
    if (
      counts.runs !== 0
      || counts.checkpoints !== 0
      || counts.turn_inputs !== 0
      || counts.effect_payloads !== 0
      || counts.directive_payloads !== 0
      || counts.plan_versions !== 0
      || counts.delegations !== 0
    ) {
      throw new Error('agent_keyring_anchor_missing_nonempty_store');
    }
    const updatedAt = clock.now().toISOString();
    const insert = database.prepare(
      `INSERT INTO agent_control_metadata(key, value, updated_at)
       VALUES (?, ?, ?)`
    );
    insert.run(
      AGENT_CONTROL_METADATA_KEYS.keyringGeneration,
      String(request.generation),
      updatedAt
    );
    insert.run(
      AGENT_CONTROL_METADATA_KEYS.activeKeyId,
      request.activeKeyId,
      updatedAt
    );
    return;
  }

  if (rows.length !== 2) {
    throw new Error('agent_keyring_anchor_partial');
  }
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  const generationValue = stored.get(AGENT_CONTROL_METADATA_KEYS.keyringGeneration);
  const activeKeyId = stored.get(AGENT_CONTROL_METADATA_KEYS.activeKeyId);
  const storedGeneration = parseStoredGeneration(generationValue);
  if (activeKeyId === undefined || !KEY_ID_PATTERN.test(activeKeyId)) {
    throw new Error('agent_keyring_anchor_corrupt');
  }
  if (request.generation < storedGeneration) {
    throw new Error('agent_keyring_anchor_rollback');
  }
  if (request.generation > storedGeneration) {
    throw new Error('agent_keyring_anchor_rotation_not_committed');
  }
  if (request.activeKeyId !== activeKeyId) {
    throw new Error('agent_keyring_anchor_active_key_mismatch');
  }

  assertProtectedRecoveryPayloadKeys(database, request);
}

export function assertKeyringAnchorVerification(
  request: AgentKeyringAnchorVerification
): void {
  if (
    !Number.isSafeInteger(request.generation)
    || request.generation < 1
    || typeof request.activeKeyId !== 'string'
    || !KEY_ID_PATTERN.test(request.activeKeyId)
    || typeof request.requiredCodecId !== 'string'
    || !KEY_ID_PATTERN.test(request.requiredCodecId)
    || !Array.isArray(request.availableKeyIds)
    || request.availableKeyIds.length === 0
    || request.availableKeyIds.length > 64
  ) {
    throw new Error('agent_keyring_anchor_request_invalid');
  }
  const available = new Set<string>();
  for (const keyId of request.availableKeyIds) {
    if (
      typeof keyId !== 'string'
      || !KEY_ID_PATTERN.test(keyId)
      || available.has(keyId)
    ) {
      throw new Error('agent_keyring_anchor_request_invalid');
    }
    available.add(keyId);
  }
  if (!available.has(request.activeKeyId)) {
    throw new Error('agent_keyring_anchor_request_active_key_unavailable');
  }
}

function parseStoredGeneration(value: string | undefined): number {
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error('agent_keyring_anchor_corrupt');
  }
  const generation = Number(value);
  if (!Number.isSafeInteger(generation)) {
    throw new Error('agent_keyring_anchor_corrupt');
  }
  return generation;
}

function assertProtectedRecoveryPayloadKeys(
  database: DatabaseSync,
  request: AgentKeyringAnchorVerification
): void {
  const rows = database.prepare(
    `SELECT 'checkpoint' AS source, codec_id, payload_json
       FROM agent_v3_checkpoints
     UNION ALL
     SELECT 'turn_input' AS source, codec_id, payload_json
       FROM agent_v3_turn_inputs
     UNION ALL
     SELECT 'effect_input' AS source, input_codec_id AS codec_id,
            input_payload_json AS payload_json
       FROM agent_v3_effect_payloads
     UNION ALL
     SELECT 'effect_result' AS source, result_codec_id AS codec_id,
            result_payload_json AS payload_json
       FROM agent_v3_effect_payloads
      WHERE result_codec_id IS NOT NULL OR result_payload_json IS NOT NULL
     UNION ALL
     SELECT 'plan_payload' AS source, codec_id, payload_json
       FROM agent_v3_plan_versions
     UNION ALL
     SELECT 'delegation_objective' AS source,
            objective_codec_id AS codec_id,
            objective_payload_json AS payload_json
       FROM agent_v3_delegations
     UNION ALL
     SELECT 'directive_response' AS source, codec_id, payload_json
       FROM agent_v3_directive_payloads`
  ).all() as unknown as ProtectedRecoveryPayloadRow[];
  const available = new Set(request.availableKeyIds);
  for (const row of rows) {
    if (row.codec_id !== request.requiredCodecId) {
      throw new Error(`agent_keyring_anchor_codec_mismatch:${row.source}`);
    }
    const keyId = parseEnvelopeKeyId(row.payload_json, row.source);
    if (!available.has(keyId)) {
      throw new Error(`agent_keyring_anchor_unknown_payload_key:${row.source}`);
    }
  }
}

function parseEnvelopeKeyId(payloadJson: string, source: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson) as unknown;
  } catch {
    throw new Error(`agent_keyring_anchor_malformed_envelope:${source}`);
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(`agent_keyring_anchor_malformed_envelope:${source}`);
  }
  const keyId = (parsed as Record<string, unknown>).keyId;
  if (typeof keyId !== 'string' || !KEY_ID_PATTERN.test(keyId)) {
    throw new Error(`agent_keyring_anchor_malformed_envelope:${source}`);
  }
  return keyId;
}

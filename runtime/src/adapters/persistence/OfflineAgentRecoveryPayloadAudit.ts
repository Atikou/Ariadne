import type { DatabaseSync } from 'node:sqlite';
import type { AgentPersistencePayloadCodec } from '@ariadne/agent-core';
import { Sha256AgentEffectInputDigester } from './Sha256AgentEffectInputDigester.js';
import { checkpointReference, effectPayloadReference, loadCheckpointPayload, loadTurnInputPayload,
  loadEffectInputPayload, loadEffectResultPayload, loadDirectivePayload } from './AgentControlPayloadReader.js';
import { decodeDelegationRecord, decodePlanVersionRecord } from './AgentControlFactReader.js';
import type { AgentCheckpointRow, AgentTurnInputPayloadRow, AgentEffectPayloadRow,
  AgentPlanVersionRow, AgentDelegationRow, AgentDirectivePayloadRow } from './AgentControlStorageTypes.js';

/** Uses the same readers and codec as Core recovery; decoded bodies never leave
 * this process. Iterate one immutable artifact at a time, including historical
 * versions, so a valid live head cannot conceal an undecryptable old snapshot. */
export async function auditOfflineAgentRecoveryPayloads(database: DatabaseSync, codec: AgentPersistencePayloadCodec): Promise<number> {
  let count = 0;
  const digester = new Sha256AgentEffectInputDigester();
  for (const item of database.prepare('SELECT * FROM agent_checkpoints ORDER BY run_id,checkpoint_version').iterate()) {
    const row = item as unknown as AgentCheckpointRow; await loadCheckpointPayload(database, codec, checkpointReference(row)); count++;
  }
  for (const item of database.prepare('SELECT * FROM agent_turn_inputs ORDER BY run_id,turn_id').iterate()) {
    const row = item as unknown as AgentTurnInputPayloadRow;
    await loadTurnInputPayload(database, codec, { runId: row.run_id, turnId: row.turn_id, inputDigest: row.input_digest }); count++;
  }
  for (const item of database.prepare('SELECT * FROM agent_effect_payloads ORDER BY run_id,effect_id').iterate()) {
    const row = item as unknown as AgentEffectPayloadRow, ref = effectPayloadReference(row);
    if (!ref.hasResult && [row.result_command_id, row.result_run_version, row.result_codec_id, row.result_payload_json].some(value => value !== null))
      throw new Error('restore_validation_partial_effect_result');
    await loadEffectInputPayload(database, codec, digester, ref); count++;
    if (ref.hasResult) { await loadEffectResultPayload(database, codec, ref); count++; }
  }
  for (const item of database.prepare('SELECT * FROM agent_plan_versions ORDER BY plan_id,plan_version').iterate()) {
    await decodePlanVersionRecord(codec, item as unknown as AgentPlanVersionRow); count++;
  }
  for (const item of database.prepare('SELECT * FROM agent_delegations ORDER BY delegation_id').iterate()) {
    await decodeDelegationRecord(database, codec, item as unknown as AgentDelegationRow); count++;
  }
  for (const item of database.prepare('SELECT * FROM agent_directive_payloads ORDER BY artifact_id').iterate()) {
    const row = item as unknown as AgentDirectivePayloadRow;
    await loadDirectivePayload(database, codec, { artifactId: row.artifact_id, runId: row.run_id, kind: row.payload_kind,
      directiveDigest: row.directive_digest, contentDigest: row.content_digest }); count++;
  }
  return count;
}

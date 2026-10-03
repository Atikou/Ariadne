import { DatabaseSync } from 'node:sqlite';
import {
  AgentRunInvariantError,
  AgentRunRecoveryConflictError,
  assertAgentTurnInputSnapshotMatchesTerminalEffectEvidence,
  assertAgentTurnInputSnapshotMatchesTurn,
  isAgentRunInboxOnlyMutation,
  type AgentEffectInputDigester,
  type AgentEffectPayload,
  type AgentJsonValue,
  type AgentTurnInputPayloadLookup,
  type AgentTurnInputPayloadReference,
  type AgentTurnInputSnapshotV1,
  type AgentTerminalEffectResultEvidence,
  type AgentPersistencePayloadCodec,
  type AgentRun,
  type AgentRunCommitArtifacts,
  type AgentRunCheckpoint,
  type AgentRunCheckpointReference,
  type AgentEffectPayloadReference
} from '@ariadne/agent-core';
import {
  assertCheckpointReference,
  canonicalJson,
  isCheckpointPayload,
  parseStoredRun,
  storageCorruption
} from './AgentControlStorageValidation.js';
import {
  decodeEffectColumn,
  decodePayload,
  decodeTurnInputColumn,
  loadEffectPayloadRow,
  loadTurnInputPayloadRow
} from './AgentControlPayloadCodec.js';
import {
  type AgentCheckpointMetadataRow,
  type AgentCheckpointRow,
  type AgentCommandRunRow,
  type AgentEffectPayloadRow,
  type AgentTurnInputPayloadRow
} from './AgentControlStorageTypes.js';

export async function assertDurableEffectResultContinuationArtifacts(
  database: DatabaseSync,
  codec: AgentPersistencePayloadCodec,
  run: AgentRun,
  artifacts: AgentRunCommitArtifacts,
  expectedVersion: number | null
): Promise<void> {
  for (const artifact of artifacts.turnInputPayloads) {
    const turn = run.turns.find((candidate) => candidate.turnId === artifact.turnId);
    if (turn?.intention.cause.kind !== 'effect_results') continue;
    if (
      expectedVersion === null
      || turn.intention.expectedRunVersion !== expectedVersion
    ) {
      throw new AgentRunInvariantError(
        'A newly committed Effect-result Turn must bind the exact predecessor Run version.'
      );
    }
    await assertTurnInputSnapshotMatchesDurableEffectResults(
      database,
      codec,
      run,
      artifact.turnId,
      artifact.payload,
      run.version
    );
  }
}

export async function assertTurnInputSnapshotMatchesDurableEffectResults(
  database: DatabaseSync,
  codec: AgentPersistencePayloadCodec,
  run: AgentRun,
  turnId: string,
  snapshot: AgentTurnInputSnapshotV1,
  introductionVersion: number
): Promise<void> {
  const turn = run.turns.find((candidate) => candidate.turnId === turnId);
  if (turn?.intention.cause.kind !== 'effect_results') return;
  const cause = turn.intention.cause;
  if (turn.intention.expectedRunVersion !== introductionVersion - 1) {
    throw storageCorruption(
      `agent_v3_turn_inputs:${run.runId}:${turnId}:continuation_version_mismatch`
    );
  }
  const sourceTurn = run.turns.find(
    (candidate) => candidate.turnId === cause.sourceTurnId
  );
  if (sourceTurn === undefined) {
    throw storageCorruption(
      `agent_v3_turn_inputs:${run.runId}:${turnId}:continuation_source_missing`
    );
  }
  const sourceSnapshot = await loadTurnInputPayload(database, codec, {
    runId: run.runId,
    turnId: sourceTurn.turnId,
    inputDigest: sourceTurn.intention.inputDigest
  });
  if (
    canonicalJson(snapshot.authorityRef) !== canonicalJson(sourceSnapshot.authorityRef)
    || canonicalJson(snapshot.availableTools) !== canonicalJson(sourceSnapshot.availableTools)
    || snapshot.messages.length
      !== sourceSnapshot.messages.length + cause.effectIds.length
    || canonicalJson(snapshot.messages.slice(0, sourceSnapshot.messages.length))
      !== canonicalJson(sourceSnapshot.messages)
  ) {
    throw new AgentRunRecoveryConflictError(
      run.runId,
      'immutable_payload_conflict',
      `Turn "${turnId}" does not exactly extend its protected source Turn.`
    );
  }
  const evidence = loadTerminalEffectResultEvidence(
    database,
    codec,
    run,
    turnId
  );
  assertAgentTurnInputSnapshotMatchesTerminalEffectEvidence(
    run,
    turnId,
    snapshot,
    evidence
  );
}

function loadTerminalEffectResultEvidence(
  database: DatabaseSync,
  codec: AgentPersistencePayloadCodec,
  run: AgentRun,
  turnId: string
): readonly AgentTerminalEffectResultEvidence[] {
  const targetIndex = run.turns.findIndex((turn) => turn.turnId === turnId);
  if (targetIndex < 0) {
    throw new AgentRunRecoveryConflictError(
      run.runId,
      'immutable_payload_conflict',
      `Turn "${turnId}" is not present in its historical Run.`
    );
  }
  const evidence: AgentTerminalEffectResultEvidence[] = [];
  for (let index = 0; index <= targetIndex; index += 1) {
    const turn = run.turns[index];
    if (turn?.intention.cause.kind !== 'effect_results') continue;
    const expectedVersion = turn.intention.expectedRunVersion;
    if (expectedVersion === null) {
      throw storageCorruption(
        `agent_v3_turn_inputs:${run.runId}:${turn.turnId}:continuation_predecessor_missing`
      );
    }
    const predecessor = loadHistoricalAgentRunVersion(
      database,
      run.runId,
      expectedVersion,
      `agent_v3_turn_inputs:${run.runId}:${turn.turnId}:continuation_predecessor`
    );
    for (const effectId of turn.intention.cause.effectIds) {
      const effect = predecessor.effects.find(
        (candidate) => candidate.effectId === effectId
      );
      const resultingEffect = run.effects.find(
        (candidate) => candidate.effectId === effectId
      );
      const row = loadEffectPayloadRow(database, run.runId, effectId);
      if (
        effect === undefined
        || resultingEffect === undefined
        || canonicalJson(effect) !== canonicalJson(resultingEffect)
        || row === undefined
        || row.run_id !== run.runId
        || row.input_digest !== effect.inputDigest
      ) {
        throw storageCorruption(
          `agent_v3_effect_payloads:${run.runId}:${effectId}:continuation_authority_missing`
        );
      }
      if (effect.state.status === 'cancelled') {
        if (
          row.result_command_id !== null
          || row.result_run_version !== null
          || row.result_codec_id !== null
          || row.result_payload_json !== null
        ) {
          throw storageCorruption(
            `agent_v3_effect_payloads:${run.runId}:${effectId}:cancelled_result_present`
          );
        }
        evidence.push({
          kind: 'aggregate_cancelled',
          runId: run.runId,
          effectId,
          toolCallId: effect.toolCallId,
          inputDigest: effect.inputDigest,
          status: 'cancelled',
          reason: effect.state.reason
        });
        continue;
      }
      if (effect.state.status !== 'succeeded' && effect.state.status !== 'failed') {
        throw storageCorruption(
          `agent_v3_effect_payloads:${run.runId}:${effectId}:continuation_result_nonterminal`
        );
      }
      if (
        row.result_command_id === null
        || row.result_run_version === null
        || row.result_codec_id === null
        || row.result_payload_json === null
        || row.result_run_version > expectedVersion
      ) {
        throw storageCorruption(
          `agent_v3_effect_payloads:${run.runId}:${effectId}:continuation_result_missing`
        );
      }
      const owner = database.prepare(
        `SELECT command_id, run_id, ordinal, expected_version,
                resulting_version, result_run_json
         FROM agent_v3_command_runs
         WHERE command_id=? AND run_id=? AND resulting_version=?`
      ).get(
        row.result_command_id,
        run.runId,
        row.result_run_version
      ) as AgentCommandRunRow | undefined;
      if (owner === undefined) {
        throw storageCorruption(
          `agent_v3_effect_payloads:${run.runId}:${effectId}:result_owner_missing`
        );
      }
      const ownerRun = parseStoredRun(
        owner.result_run_json,
        run.runId,
        row.result_run_version,
        `agent_v3_command_runs:${row.result_command_id}:${run.runId}`
      );
      const ownerEffect = ownerRun.effects.find(
        (candidate) => candidate.effectId === effectId
      );
      if (
        ownerEffect === undefined
        || canonicalJson(ownerEffect) !== canonicalJson(effect)
      ) {
        throw storageCorruption(
          `agent_v3_effect_payloads:${run.runId}:${effectId}:result_owner_mismatch`
        );
      }
      evidence.push({
        kind: 'protected_result',
        runId: run.runId,
        effectId,
        toolCallId: effect.toolCallId,
        inputDigest: effect.inputDigest,
        status: effect.state.status,
        result: decodeEffectColumn(codec, row, 'result')
      });
    }
  }
  return evidence;
}

function loadHistoricalAgentRunVersion(
  database: DatabaseSync,
  runId: string,
  version: number,
  source: string
): AgentRun {
  const rows = database.prepare(
    `SELECT command_id, run_id, ordinal, expected_version,
            resulting_version, result_run_json
     FROM agent_v3_command_runs
     WHERE run_id=? AND resulting_version=?`
  ).all(runId, version) as unknown as AgentCommandRunRow[];
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) {
    throw storageCorruption(`${source}:historical_run_missing`);
  }
  return parseStoredRun(row.result_run_json, runId, version, source);
}

export function checkpointCoversInboxOnlyAdvance(
  database: DatabaseSync,
  current: AgentRun,
  checkpointRunVersion: number
): boolean {
  if (checkpointRunVersion <= 0 || checkpointRunVersion >= current.version) return false;
  let previous = loadHistoricalAgentRunVersion(
    database,
    current.runId,
    checkpointRunVersion,
    `agent_v3_checkpoints:${current.runId}:${String(current.state.checkpointVersion)}`
  );
  for (let version = checkpointRunVersion + 1; version <= current.version; version += 1) {
    const next = version === current.version
      ? current
      : loadHistoricalAgentRunVersion(
          database,
          current.runId,
          version,
          `agent_v3_command_runs:${current.runId}:${String(version)}`
        );
    if (!isAgentRunInboxOnlyMutation(previous, next)) return false;
    previous = next;
  }
  return true;
}

export async function loadCheckpointPayload(
  database: DatabaseSync,
  codec: AgentPersistencePayloadCodec,
  reference: AgentRunCheckpointReference
): Promise<AgentRunCheckpoint> {
  assertCheckpointReference(reference);
  const row = database.prepare(
    `SELECT run_id, checkpoint_version, run_version, command_id,
            codec_id, payload_json, created_at
     FROM agent_v3_checkpoints
     WHERE run_id=? AND checkpoint_version=?`
  ).get(reference.runId, reference.checkpointVersion) as AgentCheckpointRow | undefined;
  if (row === undefined || canonicalJson(checkpointReference(row)) !== canonicalJson(reference)) {
    throw storageCorruption(
      `agent_v3_checkpoints:${reference.runId}:${String(reference.checkpointVersion)}:reference_mismatch`
    );
  }
  const decoded = decodePayload(codec, row.codec_id, row.payload_json, {
    kind: 'checkpoint',
    runId: row.run_id,
    commandId: row.command_id,
    runVersion: row.run_version,
    checkpointVersion: row.checkpoint_version
  }, `agent_v3_checkpoints:${row.run_id}:${String(row.checkpoint_version)}`);
  if (!isCheckpointPayload(decoded)) {
    throw storageCorruption(
      `agent_v3_checkpoints:${row.run_id}:${String(row.checkpoint_version)}:invalid_payload`
    );
  }
  return {
    runId: row.run_id,
    runVersion: row.run_version,
    checkpointVersion: row.checkpoint_version,
    payload: decoded,
    createdAt: row.created_at
  };
}

export async function loadTurnInputPayload(
  database: DatabaseSync,
  codec: AgentPersistencePayloadCodec,
  reference: AgentTurnInputPayloadLookup | AgentTurnInputPayloadReference
): Promise<AgentTurnInputSnapshotV1> {
  if (
    reference.runId.length === 0
    || reference.turnId.length === 0
    || !/^sha256:[a-f0-9]{64}$/u.test(reference.inputDigest)
  ) {
    throw new AgentRunInvariantError(
      'Turn input lookup requires exact Run, Turn, and input-digest identity.'
    );
  }
  const row = loadTurnInputPayloadRow(database, reference.runId, reference.turnId);
  if (
    row === undefined
    || row.input_digest !== reference.inputDigest
    || (
      'commandId' in reference
      && (
        row.command_id !== reference.commandId
        || row.run_version !== reference.runVersion
        || row.created_at !== reference.createdAt
      )
    )
  ) {
    throw storageCorruption(
      `agent_v3_turn_inputs:${reference.runId}:${reference.turnId}:reference_mismatch`
    );
  }
  const commandRun = database.prepare(
    `SELECT command_id, run_id, ordinal, expected_version,
            resulting_version, result_run_json
     FROM agent_v3_command_runs
     WHERE command_id=? AND run_id=? AND resulting_version=?`
  ).get(row.command_id, row.run_id, row.run_version) as AgentCommandRunRow | undefined;
  if (commandRun === undefined) {
    throw storageCorruption(
      `agent_v3_turn_inputs:${row.run_id}:${row.turn_id}:historical_run_missing`
    );
  }
  const historicalRun = parseStoredRun(
    commandRun.result_run_json,
    row.run_id,
    row.run_version,
    `agent_v3_command_runs:${row.command_id}:${row.run_id}`
  );
  assertTurnInputIntroductionVersion(historicalRun, row);
  const decoded = decodeTurnInputColumn(codec, row);
  try {
    await assertAgentTurnInputSnapshotMatchesTurn(
      historicalRun,
      row.turn_id,
      row.input_digest,
      decoded
    );
    await assertTurnInputSnapshotMatchesDurableEffectResults(
      database,
      codec,
      historicalRun,
      row.turn_id,
      decoded,
      row.run_version
    );
  } catch (error) {
    throw storageCorruption(
      `agent_v3_turn_inputs:${row.run_id}:${row.turn_id}:snapshot_mismatch`,
      error
    );
  }
  return decoded;
}

export function assertTurnInputIntroductionVersion(
  historicalRun: AgentRun,
  row: AgentTurnInputPayloadRow
): void {
  const turn = historicalRun.turns.find(
    (candidate) => candidate.turnId === row.turn_id
  );
  const expectedIntroductionVersion =
    (turn?.intention.expectedRunVersion ?? 0) + 1;
  if (turn === undefined || row.run_version !== expectedIntroductionVersion) {
    throw storageCorruption(
      `agent_v3_turn_inputs:${row.run_id}:${row.turn_id}:introduction_version_mismatch`
    );
  }
}

export async function loadEffectInputPayload(
  database: DatabaseSync,
  codec: AgentPersistencePayloadCodec,
  digester: AgentEffectInputDigester,
  reference: AgentEffectPayloadReference
): Promise<Omit<AgentEffectPayload, 'result'>> {
  const row = assertEffectReference(database, reference);
  const input = decodeEffectColumn(codec, row, 'input');
  const digest = digester.digest(input, {
    runId: row.run_id,
    effectId: row.effect_id
  });
  if (digest !== row.input_digest) {
    throw storageCorruption(
      `agent_v3_effect_payloads:${row.run_id}:${row.effect_id}:digest_mismatch`
    );
  }
  return {
    runId: row.run_id,
    effectId: row.effect_id,
    inputDigest: row.input_digest,
    input,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function loadEffectResultPayload(
  database: DatabaseSync,
  codec: AgentPersistencePayloadCodec,
  reference: AgentEffectPayloadReference & { readonly hasResult: true }
): Promise<AgentJsonValue> {
  const row = assertEffectReference(database, reference);
  return decodeEffectColumn(codec, row, 'result');
}

function assertEffectReference(
  database: DatabaseSync,
  reference: AgentEffectPayloadReference
): AgentEffectPayloadRow {
  const row = loadEffectPayloadRow(database, reference.runId, reference.effectId);
  if (row === undefined || canonicalJson(effectPayloadReference(row)) !== canonicalJson(reference)) {
    throw storageCorruption(
      `agent_v3_effect_payloads:${reference.runId}:${reference.effectId}:reference_mismatch`
    );
  }
  return row;
}

export function checkpointReference(
  row: AgentCheckpointMetadataRow
): AgentRunCheckpointReference {
  return {
    runId: row.run_id,
    runVersion: row.run_version,
    checkpointVersion: row.checkpoint_version,
    commandId: row.command_id,
    createdAt: row.created_at
  };
}

export function effectPayloadReference(row: AgentEffectPayloadRow): AgentEffectPayloadReference {
  if (
    row.result_payload_json !== null
    && row.result_command_id !== null
    && row.result_run_version !== null
  ) {
    return {
      runId: row.run_id,
      effectId: row.effect_id,
      inputDigest: row.input_digest,
      inputCommandId: row.input_command_id,
      inputRunVersion: row.input_run_version,
      hasResult: true,
      resultCommandId: row.result_command_id,
      resultRunVersion: row.result_run_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
  return {
    runId: row.run_id,
    effectId: row.effect_id,
    inputDigest: row.input_digest,
    inputCommandId: row.input_command_id,
    inputRunVersion: row.input_run_version,
    hasResult: false,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

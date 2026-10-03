import { DatabaseSync } from 'node:sqlite';
import {
  AgentRunCommandConflictError,
  assertAgentTurnInputSnapshotMatchesTurn,
  sha256AgentControlData,
  type AgentEffectPayloadCommit,
  type AgentDirectivePayloadCommit,
  type AgentPersistencePayloadCodec,
  type AgentRun,
  type AgentRunCommitArtifacts,
  type CommittedAgentRunCommand
} from '@ariadne/agent-core';
import {
  type AgentCheckpointRow,
  type AgentCommandRunRow,
  type AgentDirectivePayloadRow,
  type AgentEffectPayloadRow,
  type AgentTurnInputPayloadRow
} from './AgentControlStorageTypes.js';
import {
  decodeEffectColumn,
  decodePayload,
  decodeTurnInputColumn
} from './AgentControlPayloadCodec.js';
import {
  canonicalJson,
  parseStoredRun,
  storageCorruption
} from './AgentControlStorageValidation.js';
import { assertTurnInputIntroductionVersion, assertTurnInputSnapshotMatchesDurableEffectResults } from './AgentControlPayloadReader.js';

export async function assertPersistedArtifactsMatchMutation(
  database: DatabaseSync,
  codec: AgentPersistencePayloadCodec,
  command: AgentCommandRunRow,
  artifacts: AgentRunCommitArtifacts
): Promise<void> {
  const checkpointRows = database.prepare(
    `SELECT run_id, checkpoint_version, run_version, command_id,
            codec_id, payload_json, created_at
     FROM agent_v3_checkpoints WHERE command_id=? AND run_id=?`
  ).all(command.command_id, command.run_id) as unknown as AgentCheckpointRow[];
  const inputRows = database.prepare(
    `SELECT * FROM agent_v3_effect_payloads WHERE input_command_id=? AND run_id=?`
  ).all(command.command_id, command.run_id) as unknown as AgentEffectPayloadRow[];
  const resultRows = database.prepare(
    `SELECT * FROM agent_v3_effect_payloads WHERE result_command_id=? AND run_id=?`
  ).all(command.command_id, command.run_id) as unknown as AgentEffectPayloadRow[];
  const directiveRows = database.prepare(
    `SELECT * FROM agent_v3_directive_payloads
     WHERE command_id=? AND run_id=? ORDER BY artifact_id`
  ).all(command.command_id, command.run_id) as unknown as AgentDirectivePayloadRow[];
  const turnInputRows = database.prepare(
    `SELECT * FROM agent_v3_turn_inputs
     WHERE command_id=? AND run_id=? ORDER BY turn_id`
  ).all(command.command_id, command.run_id) as unknown as AgentTurnInputPayloadRow[];

  const expectedCheckpoint = artifacts.checkpoint;
  if (checkpointRows.length !== (expectedCheckpoint === undefined ? 0 : 1)) {
    throw artifactReplayConflict(command);
  }
  if (expectedCheckpoint !== undefined) {
    const row = checkpointRows[0];
    if (
      row === undefined
      || row.run_id !== command.run_id
      || row.run_version !== command.resulting_version
      || row.checkpoint_version !== expectedCheckpoint.checkpointVersion
      || row.created_at !== expectedCheckpoint.createdAt
    ) {
      throw artifactReplayConflict(command);
    }
    const decoded = decodePayload(codec, row.codec_id, row.payload_json, {
      kind: 'checkpoint',
      runId: row.run_id,
      commandId: row.command_id,
      runVersion: row.run_version,
      checkpointVersion: row.checkpoint_version
    }, `agent_v3_checkpoints:${row.run_id}:${String(row.checkpoint_version)}`);
    if (canonicalJson(decoded) !== canonicalJson(expectedCheckpoint.payload)) {
      throw artifactReplayConflict(command);
    }
  }

  const expectedTurnInputs = [...artifacts.turnInputPayloads]
    .sort((left, right) => left.turnId < right.turnId ? -1 : left.turnId > right.turnId ? 1 : 0);
  if (turnInputRows.length !== expectedTurnInputs.length) {
    throw artifactReplayConflict(command);
  }
  const historicalRun = parseStoredRun(
    command.result_run_json,
    command.run_id,
    command.resulting_version,
    `agent_v3_command_runs:${command.command_id}:${command.run_id}`
  );
  for (const [index, expected] of expectedTurnInputs.entries()) {
    const row = turnInputRows[index];
    if (
      row === undefined
      || row.turn_id !== expected.turnId
      || row.input_digest !== expected.inputDigest
      || row.run_version !== command.resulting_version
      || row.created_at !== expected.recordedAt
    ) {
      throw artifactReplayConflict(command);
    }
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
    } catch {
      throw artifactReplayConflict(command);
    }
    if (canonicalJson(decoded) !== canonicalJson(expected.payload)) {
      throw artifactReplayConflict(command);
    }
  }

  const expectedInputs = artifacts.effectPayloads.filter(
    (payload): payload is Extract<AgentEffectPayloadCommit, { kind: 'record_input' }> =>
      payload.kind === 'record_input'
  );
  const expectedResults = artifacts.effectPayloads.filter(
    (payload): payload is Extract<AgentEffectPayloadCommit, { kind: 'record_result' }> =>
      payload.kind === 'record_result'
  );
  if (inputRows.length !== expectedInputs.length || resultRows.length !== expectedResults.length) {
    throw artifactReplayConflict(command);
  }
  for (const payload of expectedInputs) {
    const row = inputRows.find((candidate) => candidate.effect_id === payload.effectId);
    if (
      row === undefined
      || row.run_id !== command.run_id
      || row.input_digest !== payload.inputDigest
      || row.input_run_version !== command.resulting_version
      || row.created_at !== payload.recordedAt
    ) {
      throw artifactReplayConflict(command);
    }
    const decoded = decodeEffectColumn(codec, row, 'input');
    if (canonicalJson(decoded) !== canonicalJson(payload.input)) {
      throw artifactReplayConflict(command);
    }
  }
  for (const payload of expectedResults) {
    const row = resultRows.find((candidate) => candidate.effect_id === payload.effectId);
    if (
      row === undefined
      || row.run_id !== command.run_id
      || row.input_digest !== payload.inputDigest
      || row.result_run_version !== command.resulting_version
      || row.updated_at !== payload.recordedAt
    ) {
      throw artifactReplayConflict(command);
    }
    const decoded = decodeEffectColumn(codec, row, 'result');
    if (canonicalJson(decoded) !== canonicalJson(payload.result)) {
      throw artifactReplayConflict(command);
    }
  }
  const expectedDirectives = [...(artifacts.directivePayloads ?? [])]
    .sort((left, right) => left.artifactId < right.artifactId ? -1 : 1);
  if (directiveRows.length !== expectedDirectives.length) {
    throw artifactReplayConflict(command);
  }
  for (const [index, payload] of expectedDirectives.entries()) {
    const row = directiveRows[index];
    if (
      row === undefined
      || row.artifact_id !== payload.artifactId
      || row.payload_kind !== payload.kind
      || row.directive_digest !== payload.directiveDigest
      || row.content_digest !== payload.contentDigest
      || row.recorded_at !== payload.recordedAt
      || row.run_version !== command.resulting_version
    ) {
      throw artifactReplayConflict(command);
    }
    const decoded = decodePayload(codec, row.codec_id, row.payload_json, {
      kind: 'directive_response',
      runId: row.run_id,
      commandId: row.command_id,
      runVersion: row.run_version,
      directiveDigest: row.directive_digest,
      contentHash: row.content_digest
    }, `agent_v3_directive_payloads:${row.artifact_id}`);
    if (
      canonicalJson(decoded) !== canonicalJson(payload.payload)
      || await sha256AgentControlData(decoded) !== row.content_digest
    ) {
      throw artifactReplayConflict(command);
    }
  }
}

function artifactReplayConflict(command: AgentCommandRunRow): AgentRunCommandConflictError {
  return new AgentRunCommandConflictError(
    command.command_id,
    command.run_id,
    command.run_id,
    'command_mismatch'
  );
}

export async function assertCommittedDirectiveArtifacts(
  database: DatabaseSync,
  codec: AgentPersistencePayloadCodec,
  committed: CommittedAgentRunCommand
): Promise<void> {
  for (const mutation of committed.mutations) {
    for (const reference of committedDirectiveReferences(mutation.run)) {
      const row = database.prepare(
        'SELECT * FROM agent_v3_directive_payloads WHERE artifact_id=?'
      ).get(reference.artifactId) as AgentDirectivePayloadRow | undefined;
      if (row === undefined) {
        throw storageCorruption(
          `agent_v3_directive_payloads:${reference.artifactId}:missing`
        );
      }
      const payload = decodePayload(codec, row.codec_id, row.payload_json, {
        kind: 'directive_response',
        runId: row.run_id,
        commandId: row.command_id,
        runVersion: row.run_version,
        directiveDigest: row.directive_digest,
        contentHash: row.content_digest
      }, `agent_v3_directive_payloads:${row.artifact_id}`);
      if (
        row.run_id !== mutation.runId
        || row.payload_kind !== reference.kind
        || row.directive_digest !== reference.directiveDigest
        || row.content_digest !== reference.contentDigest
        || await sha256AgentControlData(payload) !== reference.contentDigest
      ) {
        throw storageCorruption(
          `agent_v3_directive_payloads:${reference.artifactId}:metadata_mismatch`
        );
      }
    }
  }
}

interface CommittedDirectiveArtifactReference {
  readonly artifactId: string;
  readonly kind: AgentDirectivePayloadCommit['kind'];
  readonly directiveDigest: string;
  readonly contentDigest: string;
}

function committedDirectiveReferences(
  run: AgentRun
): readonly CommittedDirectiveArtifactReference[] {
  const references: CommittedDirectiveArtifactReference[] = [];
  for (const turn of run.turns) {
    for (const attempt of turn.attempts) {
      if (attempt.state.status !== 'succeeded') continue;
      const directive = attempt.state.directive;
      if (directive.kind === 'respond') {
        references.push({
          artifactId: directive.contentRef,
          kind: 'response_content',
          directiveDigest: attempt.state.directiveDigest,
          contentDigest: directive.contentDigest
        });
      } else if (directive.kind === 'ask_user') {
        references.push({
          artifactId: directive.questionRef,
          kind: 'user_question',
          directiveDigest: attempt.state.directiveDigest,
          contentDigest: directive.questionDigest
        });
      } else if (directive.kind === 'checkpoint') {
        references.push({
          artifactId: directive.reasonRef,
          kind: 'checkpoint_reason',
          directiveDigest: attempt.state.directiveDigest,
          contentDigest: directive.reasonDigest
        });
      } else if (
        directive.kind === 'complete'
        && directive.outputRef !== undefined
        && directive.outputDigest !== undefined
      ) {
        references.push({
          artifactId: directive.outputRef,
          kind: 'completion_output',
          directiveDigest: attempt.state.directiveDigest,
          contentDigest: directive.outputDigest
        });
      } else if (directive.kind === 'fail') {
        references.push({
          artifactId: directive.messageRef,
          kind: 'failure_message',
          directiveDigest: attempt.state.directiveDigest,
          contentDigest: directive.messageDigest
        });
      }
    }
  }
  return references;
}

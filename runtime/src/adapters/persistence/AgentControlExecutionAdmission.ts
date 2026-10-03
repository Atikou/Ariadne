import { DatabaseSync } from 'node:sqlite';
import { type AgentPersistencePayloadCodec, type AgentRunCheckpointPayload } from '@ariadne/agent-core';
import type { AgentRunExecutionIntent } from '../../control/ports/AgentRunExecutionStarter.js';
import { AgentRunExecutionIntentStoreError } from './agent-control/execution-intent/SqliteAgentExecutionIntentStore.js';
import {
  type AgentCheckpointRow,
  type AgentCommandRunRow,
  type AgentRunRow
} from './AgentControlStorageTypes.js';
import { loadCommittedCommandRecord } from './AgentControlCommandJournal.js';
import {
  canonicalJson,
  isRecord,
  parseRunRow
} from './AgentControlStorageValidation.js';
import { checkpointReference, loadCheckpointPayload } from './AgentControlPayloadReader.js';

export async function verifyExactAdmittedRunForExecution(
  database: DatabaseSync,
  codec: AgentPersistencePayloadCodec,
  intent: AgentRunExecutionIntent
): Promise<string> {
  const commandRunRows = database.prepare(
    `SELECT command_id, run_id, ordinal, expected_version,
            resulting_version, result_run_json
     FROM agent_v3_command_runs
     WHERE run_id=? AND resulting_version=?`
  ).all(intent.runId, intent.admittedRunVersion) as unknown as AgentCommandRunRow[];
  const commandRun = commandRunRows[0];
  if (
    commandRunRows.length !== 1
    || commandRun === undefined
    || commandRun.run_id !== intent.runId
    || commandRun.resulting_version !== 1
    || commandRun.expected_version !== null
    || commandRun.ordinal !== 0
  ) {
    throw executionAdmissionMismatch(
      'Execution intent has no unique v1 Run-creation command receipt.'
    );
  }

  const committed = loadCommittedCommandRecord(database, commandRun.command_id);
  const mutation = committed?.mutations[0];
  const run = mutation?.run;
  const currentRow = database.prepare(
    `SELECT run_id, version, state_status, aggregate_json, created_at, updated_at
     FROM agent_v3_runs WHERE run_id=?`
  ).get(intent.runId) as AgentRunRow | undefined;
  const current = currentRow === undefined
    ? null
    : parseRunRow(currentRow, 'agent_v3_runs');
  const turn = run?.turns[0];
  const attempt = turn?.attempts[0];
  const expectedEventTypes = [
    'run.admitted',
    'run.state_changed',
    'turn.registered',
    'inference_attempt.registered'
  ] as const;
  if (
    committed === null
    || committed.mutations.length !== 1
    || mutation === undefined
    || run === undefined
    || current === null
    || committed.commandId !== commandRun.command_id
    || mutation.runId !== intent.runId
    || mutation.resultingVersion !== 1
    || run.runId !== intent.runId
    || run.version !== 1
    || current.version !== 1
    || canonicalJson(current) !== canonicalJson(run)
    || run.createdAt !== intent.occurredAt
    || run.updatedAt !== intent.occurredAt
    || run.state.status !== 'running'
    || run.state.checkpointVersion !== 1
    || run.state.enteredAt !== intent.occurredAt
    || run.binding.sessionId !== intent.sessionId
    || run.binding.workspace.workspaceId !== intent.workspaceId
    || run.binding.objectiveRef.kind !== 'conversation_message'
    || run.binding.objectiveRef.messageId !== intent.objectiveMessageId
    || run.binding.objectiveRef.messageVersion !== intent.objectiveMessageVersion
    || run.binding.objectiveRef.contentDigest !== intent.objectiveDigest
    || run.binding.budget.runId !== intent.runId
    || run.turns.length !== 1
    || run.effects.length !== 0
    || turn === undefined
    || turn.runId !== intent.runId
    || turn.createdAt !== intent.occurredAt
    || turn.intention.expectedRunVersion !== null
    || turn.intention.checkpointVersion !== 1
    || turn.intention.sessionId !== intent.sessionId
    || turn.intention.objectiveRef.kind !== 'conversation_message'
    || turn.intention.objectiveRef.messageId !== intent.objectiveMessageId
    || turn.intention.objectiveRef.messageVersion !== intent.objectiveMessageVersion
    || turn.intention.objectiveRef.contentDigest !== intent.objectiveDigest
    || turn.attempts.length !== 1
    || attempt === undefined
    || attempt.runId !== intent.runId
    || attempt.turnId !== turn.turnId
    || attempt.state.status !== 'intended'
    || attempt.state.intendedAt !== intent.occurredAt
    || mutation.events.length !== expectedEventTypes.length
    || mutation.events.some((event, index) => (
      event.commandId !== commandRun.command_id
      || event.runId !== intent.runId
      || event.runVersion !== 1
      || event.sequence !== index + 1
      || event.occurredAt !== intent.occurredAt
      || event.payload.type !== expectedEventTypes[index]
    ))
  ) {
    throw executionAdmissionMismatch(
      'Execution intent does not bind the exact unstarted admitted v1 Run and unique intended Attempt.'
    );
  }
  const [admitted, changed, registeredTurn, registeredAttempt] = mutation.events;
  if (
    admitted?.payload.type !== 'run.admitted'
    || canonicalJson(admitted.payload.binding) !== canonicalJson(run.binding)
    || changed?.payload.type !== 'run.state_changed'
    || changed.payload.from !== 'absent'
    || canonicalJson(changed.payload.to) !== canonicalJson(run.state)
    || registeredTurn?.payload.type !== 'turn.registered'
    || canonicalJson(registeredTurn.payload.turn) !== canonicalJson(turn)
    || registeredAttempt?.payload.type !== 'inference_attempt.registered'
    || registeredAttempt.payload.turnId !== turn.turnId
    || canonicalJson(registeredAttempt.payload.attempt) !== canonicalJson(attempt)
  ) {
    throw executionAdmissionMismatch(
      'Execution intent admission events differ from the immutable v1 Run receipt.'
    );
  }

  const checkpointRow = database.prepare(
    `SELECT run_id, checkpoint_version, run_version, command_id,
            codec_id, payload_json, created_at
     FROM agent_v3_checkpoints
     WHERE command_id=? AND run_id=? AND run_version=1`
  ).get(commandRun.command_id, intent.runId) as AgentCheckpointRow | undefined;
  if (
    checkpointRow === undefined
    || checkpointRow.checkpoint_version !== 1
    || checkpointRow.created_at !== intent.occurredAt
  ) {
    throw executionAdmissionMismatch(
      'Execution intent admission checkpoint is missing or has different authority metadata.'
    );
  }
  const checkpoint = await loadCheckpointPayload(
    database,
    codec,
    checkpointReference(checkpointRow)
  );
  if (!isExactExecutionAdmissionCheckpoint(checkpoint.payload, intent)) {
    throw executionAdmissionMismatch(
      'Execution intent differs from the exact durable admission checkpoint.'
    );
  }
  return commandRun.command_id;
}

function isExactExecutionAdmissionCheckpoint(
  payload: AgentRunCheckpointPayload,
  intent: AgentRunExecutionIntent
): boolean {
  const continuation = payload.engineContinuation;
  if (!isRecord(continuation)) return false;
  const objectiveRef = continuation.objectiveRef;
  return isRecord(objectiveRef)
    && hasExactDataKeys(payload, [
      'format', 'schemaVersion', 'engineContinuation', 'modelContext'
    ])
    && payload.format === 'ariadne.agent-checkpoint'
    && payload.schemaVersion === 1
    && payload.modelContext === null
    && hasExactDataKeys(continuation, [
      'phase',
      'sagaId',
      'runRequestId',
      'sessionId',
      'workspaceId',
      'objectiveRef'
    ])
    && continuation.phase === 'turn_intended'
    && continuation.sagaId === intent.sagaId
    && continuation.runRequestId === intent.runRequestId
    && continuation.sessionId === intent.sessionId
    && continuation.workspaceId === intent.workspaceId
    && hasExactDataKeys(objectiveRef, [
      'kind', 'messageId', 'messageVersion', 'contentDigest'
    ])
    && objectiveRef.kind === 'conversation_message'
    && objectiveRef.messageId === intent.objectiveMessageId
    && objectiveRef.messageVersion === intent.objectiveMessageVersion
    && objectiveRef.contentDigest === intent.objectiveDigest;
}

function hasExactDataKeys(value: object, keys: readonly string[]): boolean {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  const allowed = new Set(keys);
  if (
    actual.length !== keys.length
    || actual.some((key) => !allowed.has(key))
    || keys.some((key) => !Object.hasOwn(value, key))
  ) return false;
  return actual.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined
      && descriptor.get === undefined
      && descriptor.set === undefined;
  });
}

function executionAdmissionMismatch(
  message: string
): AgentRunExecutionIntentStoreError {
  return new AgentRunExecutionIntentStoreError(
    'AGENT_EXECUTION_ADMISSION_MISMATCH',
    message
  );
}

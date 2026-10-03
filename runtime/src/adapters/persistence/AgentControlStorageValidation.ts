import {
  AgentRunInvariantError,
  AgentRunRecoveryConflictError,
  assertAgentControlCommitFacts,
  EMPTY_AGENT_CONTROL_COMMIT_FACTS,
  assertValidAgentRun,
  type AgentDirectivePayloadLookup,
  type AgentJsonValue,
  type AgentRun,
  type AgentRunCommandCommit,
  type AgentRunCommitMutation,
  type AgentRunEvent,
  type AgentRunRecoveryQueryRequest,
  type AgentRunCheckpointPayload,
  type AgentRunCheckpointReference,
  type CommittedAgentRunCommand
} from '@ariadne/agent-core';
import { type AgentRunRow } from './AgentControlStorageTypes.js';

export function assertValidCommandCommit(commit: AgentRunCommandCommit): void {
  if (commit.commandId.length === 0) {
    throw new AgentRunInvariantError('Command ID must be non-empty.');
  }
  if (!isCommandDigest(commit.commandDigest)) {
    throw new AgentRunInvariantError(
      'Command digest must be a canonical SHA-256 identity.'
    );
  }
  if (commit.mutations.length === 0) {
    throw new AgentRunInvariantError(
      'Every committed command must contain at least one Run mutation.'
    );
  }
  assertAgentControlCommitFacts(
    commit.facts ?? EMPTY_AGENT_CONTROL_COMMIT_FACTS
  );
  const eventIds = new Set<string>();
  let previousRunId: string | undefined;
  for (const mutation of commit.mutations) {
    assertValidAgentRun(mutation.run);
    if (
      mutation.runId.length === 0
      || (previousRunId !== undefined && previousRunId >= mutation.runId)
    ) {
      throw new AgentRunInvariantError(
        'Run mutations must have non-empty, unique IDs in strict code-unit order.'
      );
    }
    previousRunId = mutation.runId;
    if (mutation.run.runId !== mutation.runId) {
      throw new AgentRunInvariantError('Commit Run ID must match its aggregate.');
    }
    if (
      !Number.isInteger(mutation.resultingVersion)
      || mutation.resultingVersion <= 0
      || (
        mutation.expectedVersion !== null
        && (
          !Number.isInteger(mutation.expectedVersion)
          || mutation.expectedVersion <= 0
        )
      )
    ) {
      throw new AgentRunInvariantError('Commit versions must be valid positive integers.');
    }
    if (mutation.events.length === 0) {
      throw new AgentRunInvariantError('Every Run mutation must emit events.');
    }
    assertEventSequence(
      mutation.events,
      commit.commandId,
      mutation.runId,
      mutation.resultingVersion
    );
    for (const event of mutation.events) {
      if (eventIds.has(event.eventId)) {
        throw new AgentRunInvariantError(
          'Event IDs must be unique across every Run mutation in one command.'
        );
      }
      eventIds.add(event.eventId);
    }
    assertValidCommitArtifacts(mutation);
  }
}

function assertValidCommitArtifacts(commit: AgentRunCommitMutation): void {
  const checkpoint = commit.artifacts.checkpoint;
  if (checkpoint !== undefined) {
    if (
      !Number.isInteger(checkpoint.checkpointVersion)
      || checkpoint.checkpointVersion <= 0
      || checkpoint.checkpointVersion !== commit.run.state.checkpointVersion
      || !isTimestamp(checkpoint.createdAt)
    ) {
      throw new AgentRunRecoveryConflictError(
        commit.runId,
        'checkpoint_mismatch',
        'A committed checkpoint must exactly match the resulting AgentRun checkpoint.'
      );
    }
    assertJsonValue(checkpoint.payload, 'checkpoint.payload');
  }

  const turnIds = new Set<string>();
  for (const payload of commit.artifacts.turnInputPayloads) {
    if (
      payload.turnId.length === 0
      || !/^sha256:[a-f0-9]{64}$/u.test(payload.inputDigest)
      || !isTimestamp(payload.recordedAt)
      || turnIds.has(payload.turnId)
    ) {
      throw new AgentRunInvariantError(
        'Turn input artifacts must have one valid mutation per Turn and command.'
      );
    }
    turnIds.add(payload.turnId);
    assertJsonValue(
      payload.payload as unknown as AgentJsonValue,
      `turnInputPayloads.${payload.turnId}.payload`
    );
  }

  const effectIds = new Set<string>();
  for (const payload of commit.artifacts.effectPayloads) {
    if (
      payload.effectId.length === 0
      || payload.inputDigest.length === 0
      || !isTimestamp(payload.recordedAt)
      || effectIds.has(payload.effectId)
    ) {
      throw new AgentRunInvariantError(
        'Effect recovery artifacts must have one valid mutation per effect and command.'
      );
    }
    effectIds.add(payload.effectId);
    const effect = commit.run.effects.find(
      (candidate) => candidate.effectId === payload.effectId
    );
    if (effect === undefined || effect.inputDigest !== payload.inputDigest) {
      throw new AgentRunRecoveryConflictError(
        commit.runId,
        'effect_digest_mismatch',
        `Effect payload "${payload.effectId}" does not match the committed effect digest.`
      );
    }
    if (payload.kind === 'record_input') {
      assertJsonValue(payload.input, `effectPayloads.${payload.effectId}.input`);
      continue;
    }
    if (effect.state.status !== 'succeeded' && effect.state.status !== 'failed') {
      throw new AgentRunRecoveryConflictError(
        commit.runId,
        'immutable_payload_conflict',
        `Effect payload "${payload.effectId}" cannot record a result before a known terminal outcome.`
      );
    }
    assertJsonValue(payload.result, `effectPayloads.${payload.effectId}.result`);
  }
}

export function assertEventSequence(
  events: readonly AgentRunEvent[],
  commandId: string,
  runId: string,
  runVersion: number
): void {
  const eventIds = new Set<string>();
  events.forEach((event, index) => {
    if (
      event.commandId !== commandId
      || event.runId !== runId
      || event.runVersion !== runVersion
      || event.sequence !== index + 1
      || event.eventId.length === 0
      || eventIds.has(event.eventId)
      || !Number.isFinite(Date.parse(event.occurredAt))
      || !isRecord(event.payload)
      || typeof event.payload.type !== 'string'
    ) {
      throw new AgentRunInvariantError(
        'Committed events must form one ordered command/run/version sequence.'
      );
    }
    eventIds.add(event.eventId);
  });
}

export function assertStableRunIdentity(current: AgentRun, next: AgentRun): void {
  if (
    current.runId !== next.runId
    || current.createdAt !== next.createdAt
    || serializeJson(current.binding) !== serializeJson(next.binding)
  ) {
    throw new AgentRunInvariantError(
      'Run identity and startup binding are immutable after creation.'
    );
  }
}

export function parseRunRow(row: AgentRunRow, source: string): AgentRun {
  const run = parseStoredRun(row.aggregate_json, row.run_id, row.version, source);
  if (
    run.state.status !== row.state_status
    || run.createdAt !== row.created_at
    || run.updatedAt !== row.updated_at
  ) {
    throw storageCorruption(`${source}:${row.run_id}:metadata_mismatch`);
  }
  return run;
}

export function parseStoredRun(
  json: string,
  expectedRunId: string,
  expectedVersion: number,
  source: string
): AgentRun {
  const parsed = parseJson(json, source);
  if (!isRecord(parsed)) throw storageCorruption(`${source}:run_not_object`);
  // Historical Run envelopes predate the inbox field. Normalize that exact
  // legacy shape before applying the current aggregate validator.
  const run = (
    Object.prototype.hasOwnProperty.call(parsed, 'inbox')
      ? parsed
      : { ...parsed, inbox: [] }
  ) as unknown as AgentRun;
  try {
    assertValidAgentRun(run);
  } catch (error) {
    throw storageCorruption(`${source}:invalid_run`, error);
  }
  if (run.runId !== expectedRunId || run.version !== expectedVersion) {
    throw storageCorruption(`${source}:run_metadata_mismatch`);
  }
  return run;
}

export function sameCommittedResult(
  existing: CommittedAgentRunCommand,
  commit: AgentRunCommandCommit
): boolean {
  return existing.commandId === commit.commandId
    && existing.commandDigest === commit.commandDigest
    && existing.mutations.length === commit.mutations.length
    && existing.mutations.every((mutation, index) => {
      const expected = commit.mutations[index];
      return expected !== undefined
        && mutation.runId === expected.runId
        && mutation.resultingVersion === expected.resultingVersion
        && serializeJson(mutation.run) === serializeJson(expected.run)
        && serializeJson(mutation.events) === serializeJson(expected.events);
    });
}

export function assertRecoveryQueryRequest(request: AgentRunRecoveryQueryRequest): void {
  const limit = request.limit ?? 100;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 1_000) {
    throw new AgentRunInvariantError('Recovery query limit must be between 1 and 1000.');
  }
  if (
    request.after !== undefined
    && (!isTimestamp(request.after.createdAt) || request.after.runId.length === 0)
  ) {
    throw new AgentRunInvariantError('Recovery query cursors must be valid and immutable.');
  }
}

export function assertCheckpointReference(reference: AgentRunCheckpointReference): void {
  if (
    reference.runId.length === 0
    || reference.commandId.length === 0
    || !Number.isInteger(reference.runVersion)
    || reference.runVersion <= 0
    || !Number.isInteger(reference.checkpointVersion)
    || reference.checkpointVersion <= 0
    || !isTimestamp(reference.createdAt)
  ) {
    throw new AgentRunInvariantError('Checkpoint references must contain exact durable metadata.');
  }
}

export function assertDirectivePayloadLookup(
  reference: AgentDirectivePayloadLookup
): void {
  const record = reference as unknown;
  if (
    !isRecord(record)
    || Object.keys(record).length !== 5
    || !Object.hasOwn(record, 'runId')
    || !Object.hasOwn(record, 'artifactId')
    || !Object.hasOwn(record, 'kind')
    || !Object.hasOwn(record, 'directiveDigest')
    || !Object.hasOwn(record, 'contentDigest')
    || typeof reference.runId !== 'string'
    || reference.runId.length === 0
    || reference.runId.length > 256
    || reference.runId.trim() !== reference.runId
    || typeof reference.artifactId !== 'string'
    || reference.artifactId.length === 0
    || reference.artifactId.length > 256
    || reference.artifactId.trim() !== reference.artifactId
    || ![
      'response_content',
      'user_question',
      'checkpoint_reason',
      'completion_output',
      'failure_message'
    ].includes(reference.kind)
    || !/^sha256:[0-9a-f]{64}$/u.test(reference.directiveDigest)
    || !/^sha256:[0-9a-f]{64}$/u.test(reference.contentDigest)
  ) {
    throw new AgentRunInvariantError(
      'Directive payload lookup requires one exact immutable artifact identity.'
    );
  }
}

export function isCheckpointPayload(value: AgentJsonValue): value is AgentRunCheckpointPayload {
  return isRecord(value)
    && value.format === 'ariadne.agent-checkpoint'
    && value.schemaVersion === 1
    && Object.hasOwn(value, 'engineContinuation')
    && Object.hasOwn(value, 'modelContext');
}

export function assertJsonValue(
  value: unknown,
  path: string,
  ancestors = new Set<object>()
): asserts value is AgentJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new AgentRunInvariantError(`${path} must contain finite JSON numbers.`);
  }
  if (typeof value !== 'object' || value === undefined || ancestors.has(value)) {
    throw new AgentRunInvariantError(`${path} must be acyclic JSON.`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((item, index) =>
        assertJsonValue(item, `${path}[${String(index)}]`, ancestors)
      );
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) {
        throw new AgentRunInvariantError(`${path}.${key} must not be undefined.`);
      }
      assertJsonValue(item, `${path}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function isTimestamp(value: string): boolean {
  return value.length > 0 && Number.isFinite(Date.parse(value));
}

export function serializeJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new AgentRunInvariantError('AgentRun persistence value is not JSON serializable.');
  }
  return serialized;
}

export function isCommandDigest(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/u.test(value);
}

export function parseJson(value: string, source: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw storageCorruption(`${source}:invalid_json`, error);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function storageCorruption(message: string, cause?: unknown): Error {
  return new Error(`agent_v3_storage_corruption:${message}`, { cause });
}

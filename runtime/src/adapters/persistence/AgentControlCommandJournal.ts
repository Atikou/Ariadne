import { DatabaseSync } from 'node:sqlite';
import {
  AgentRunCommandConflictError,
  type AgentRunCommandCommit,
  type AgentRunReplayArtifacts,
  type CommittedAgentRunCommand
} from '@ariadne/agent-core';
import { parseAgentEventRow, type AgentEventRow } from './agent-control/rows/AgentEventRowMapper.js';
import { type AgentCommandRow, type AgentCommandRunRow } from './AgentControlStorageTypes.js';
import {
  assertEventSequence,
  isCommandDigest,
  isTimestamp,
  parseStoredRun,
  storageCorruption
} from './AgentControlStorageValidation.js';
import { countPersistedCommandFacts } from './AgentControlFactReader.js';

export function loadCommittedCommandRecord(
  database: DatabaseSync,
  commandId: string
): CommittedAgentRunCommand | null {
  const command = database.prepare(
    `SELECT command_id, command_digest, mutation_count, fact_count, committed_at
     FROM agent_v3_commands WHERE command_id=?`
  ).get(commandId) as AgentCommandRow | undefined;
  if (command === undefined) return null;
  if (
    !isCommandDigest(command.command_digest)
    || !Number.isSafeInteger(command.mutation_count)
    || command.mutation_count <= 0
    || !Number.isSafeInteger(command.fact_count)
    || command.fact_count < 0
    || !isTimestamp(command.committed_at)
  ) {
    throw storageCorruption(`command_metadata_invalid:${commandId}`);
  }
  const rows = database.prepare(
    `SELECT command_id, run_id, ordinal, expected_version,
            resulting_version, result_run_json
     FROM agent_v3_command_runs
     WHERE command_id=? ORDER BY ordinal`
  ).all(commandId) as unknown as AgentCommandRunRow[];
  if (rows.length !== command.mutation_count) {
    throw storageCorruption(`command_mutation_count_mismatch:${commandId}`);
  }
  if (countPersistedCommandFacts(database, commandId) !== command.fact_count) {
    throw storageCorruption(`command_fact_count_mismatch:${commandId}`);
  }
  let previousRunId: string | undefined;
  for (const [ordinal, row] of rows.entries()) {
    if (
      row.command_id !== commandId
      || row.ordinal !== ordinal
      || (previousRunId !== undefined && previousRunId >= row.run_id)
      || !Number.isSafeInteger(row.resulting_version)
      || row.resulting_version <= 0
      || (
        row.expected_version !== null
        && (
          !Number.isSafeInteger(row.expected_version)
          || row.expected_version <= 0
        )
      )
    ) {
      throw storageCorruption(`command_run_metadata_invalid:${commandId}:${row.run_id}`);
    }
    previousRunId = row.run_id;
  }

  const eventRows = database.prepare(
    `SELECT event.event_id, event.command_id, event.run_id,
            event.run_version, event.sequence, event.occurred_at,
            event.event_json
     FROM agent_v3_events AS event
     INNER JOIN agent_v3_command_runs AS command_run
       ON command_run.command_id=event.command_id
      AND command_run.run_id=event.run_id
      AND command_run.resulting_version=event.run_version
     WHERE event.command_id=?
     ORDER BY command_run.ordinal, event.sequence`
  ).all(commandId) as unknown as AgentEventRow[];
  const mutations = rows.map((row) => {
    const run = parseStoredRun(
      row.result_run_json,
      row.run_id,
      row.resulting_version,
      `agent_v3_command_runs:${commandId}:${row.run_id}`
    );
    const events = eventRows
      .filter((event) => event.run_id === row.run_id)
      .map(parseAgentEventRow);
    if (events.length === 0) {
      throw storageCorruption(`command_run_without_events:${commandId}:${row.run_id}`);
    }
    assertEventSequence(events, commandId, row.run_id, row.resulting_version);
    return {
      runId: row.run_id,
      resultingVersion: row.resulting_version,
      run,
      events
    };
  });
  const countedEvents = mutations.reduce((count, item) => count + item.events.length, 0);
  if (countedEvents !== eventRows.length) {
    throw storageCorruption(`command_event_ownership_mismatch:${commandId}`);
  }
  return {
    commandId: command.command_id,
    commandDigest: command.command_digest,
    mutations
  };
}

export function loadCommandRunRow(
  database: DatabaseSync,
  commandId: string,
  runId: string
): AgentCommandRunRow | undefined {
  return database.prepare(
    `SELECT command_id, run_id, ordinal, expected_version,
            resulting_version, result_run_json
     FROM agent_v3_command_runs WHERE command_id=? AND run_id=?`
  ).get(commandId, runId) as AgentCommandRunRow | undefined;
}

export function assertReplayArtifactsShape(
  committed: CommittedAgentRunCommand,
  expectations: readonly AgentRunReplayArtifacts[]
): void {
  if (
    expectations.length !== committed.mutations.length
    || expectations.some((expectation, index) =>
      expectation.runId !== committed.mutations[index]?.runId
    )
  ) {
    if (committed.mutations.length === 1 && expectations.length === 1) {
      throw new AgentRunCommandConflictError(
        committed.commandId,
        committed.mutations[0]!.runId,
        expectations[0]!.runId
      );
    }
    throw new AgentRunCommandConflictError(
      committed.commandId,
      describeCommittedMutations(committed.mutations),
      expectations.map((item) => item.runId).join(','),
      'command_mismatch'
    );
  }
}

export function persistedExpectedVersionsMatch(
  database: DatabaseSync,
  commit: AgentRunCommandCommit
): boolean {
  return commit.mutations.every((mutation) => {
    const row = loadCommandRunRow(database, commit.commandId, mutation.runId);
    return row?.expected_version === mutation.expectedVersion;
  });
}

export function describeCommittedMutations(
  mutations: readonly { readonly runId: string; readonly resultingVersion: number }[]
): string {
  return mutations
    .map((mutation) => `${mutation.runId}@${String(mutation.resultingVersion)}`)
    .join(',');
}

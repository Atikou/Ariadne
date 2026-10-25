import type { DatabaseSync } from 'node:sqlite';
import { AgentRunInvariantError, type AgentRun } from '@ariadne/agent-core';
import type { AgentCommittedMutationRow } from './AgentControlStorageTypes.js';
import { isCommandDigest, parseStoredRun, storageCorruption } from './AgentControlStorageValidation.js';

/** Reads the committed immutable result; never reconstructs history from the mutable aggregate. */
export function loadHistoricalAgentRun(database: DatabaseSync, runId: string, version: number): AgentRun | null {
  if (runId.trim().length === 0 || !Number.isSafeInteger(version) || version <= 0) {
    throw new AgentRunInvariantError('Historical Run lookup requires a non-empty Run ID and a positive safe version.');
  }
  const row = database.prepare(`SELECT command.command_id, command.command_digest, command.mutation_count,
    command_run.run_id, command_run.ordinal, command_run.expected_version,
    command_run.resulting_version, command_run.result_run_json
    FROM agent_command_runs AS command_run INNER JOIN agent_commands AS command
      ON command.command_id=command_run.command_id
    WHERE command_run.run_id=? AND command_run.resulting_version=?`).get(runId, version) as AgentCommittedMutationRow | undefined;
  if (row === undefined) return null;
  if (row.run_id !== runId || row.resulting_version !== version) {
    throw storageCorruption(`historical_run_identity_mismatch:${runId}:${String(version)}`);
  }
  if (!isCommandDigest(row.command_digest)) throw storageCorruption(`command_digest_invalid:${row.command_id}`);
  return parseStoredRun(row.result_run_json, row.run_id, row.resulting_version,
    `agent_command_runs:${row.command_id}:${row.run_id}`);
}

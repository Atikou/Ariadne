import { DatabaseSync } from 'node:sqlite';
import {
  AgentRunCommandConflictError,
  AgentRunInvariantError,
  AgentRunVersionConflictError,
  assertAgentControlCommitFacts,
  EMPTY_AGENT_CONTROL_COMMIT_FACTS,
  countAgentControlCommitFacts,
  sha256AgentControlData,
  type AgentEffectInputDigester,
  type AgentEffectResultContinuationAuthorityCheck,
  type AgentPersistencePayloadCodec,
  type AgentRun,
  type AgentRunCommandCommit,
  type AgentRunReplayArtifacts,
  type AgentControlCommitFacts,
  type AgentPlanReference,
  type AgentPlanVersionCommit,
  type AgentBudgetSnapshot,
  type AgentDelegationRecord,
  type AgentChildTerminalCommit,
  type AgentRunTransaction,
  type CommittedAgentRunCommand
} from '@ariadne/agent-core';
import {
  assertValidCommandCommit,
  canonicalJson,
  parseRunRow,
  sameCommittedResult,
  serializeJson,
  storageCorruption
} from './AgentControlStorageValidation.js';
import {
  type AgentChildTerminalRow,
  type AgentDelegationRow,
  type AgentPlanVersionRow,
  type AgentRunRow,
  type PreparedCommandMutation
} from './AgentControlStorageTypes.js';
import { decodePayload } from './AgentControlPayloadCodec.js';
import {
  assertPersistedFactsMatchCommand,
  decodeDelegationRecord,
  loadBudgetSnapshotRecord,
  parseChildTerminalRow
} from './AgentControlFactReader.js';
import {
  assertReplayArtifactsShape,
  describeCommittedMutations,
  loadCommandRunRow,
  loadCommittedCommandRecord,
  persistedExpectedVersionsMatch
} from './AgentControlCommandJournal.js';
import { assertCommittedDirectiveArtifacts, assertPersistedArtifactsMatchMutation } from './AgentControlPayloadReplay.js';
import { prepareCommandMutations } from './AgentControlPayloadPreparation.js';
import { prepareCommandFacts } from './AgentControlFactPreparation.js';
import { persistPreparedCommitArtifacts } from './AgentControlPayloadWriter.js';
import { persistPreparedCommandFacts } from './AgentControlFactWriter.js';

function assertEffectResultContinuationAuthorityCheck(
  check: AgentEffectResultContinuationAuthorityCheck
): void {
  if (
    check.commandId.length === 0
    || check.runId.length === 0
    || check.turnId.length === 0
    || !Number.isSafeInteger(check.expectedVersion)
    || check.expectedVersion <= 0
    || !Number.isSafeInteger(check.resultingVersion)
    || check.resultingVersion <= 0
    || !/^sha256:[a-f0-9]{64}$/u.test(check.inputDigest)
    || check.snapshot.format !== 'ariadne.agent-turn-input'
    || check.snapshot.schemaVersion !== 1
    || check.snapshot.runId !== check.runId
    || check.snapshot.turnId !== check.turnId
    || check.snapshot.cause.kind !== 'effect_results'
  ) {
    throw new AgentRunInvariantError(
      'Effect-result continuation authority requires one exact protected Turn identity.'
    );
  }
}

function effectResultContinuationAuthorityFingerprint(
  check: AgentEffectResultContinuationAuthorityCheck
): string {
  return canonicalJson(check);
}

function requireEffectResultContinuationAuthorityChecks(
  commit: AgentRunCommandCommit,
  pending: ReadonlySet<string>
): readonly string[] {
  const required: string[] = [];
  for (const mutation of commit.mutations) {
    for (const payload of mutation.artifacts.turnInputPayloads) {
      const turn = mutation.run.turns.find(
        (candidate) => candidate.turnId === payload.turnId
      );
      if (turn?.intention.cause.kind !== 'effect_results') continue;
      if (mutation.expectedVersion === null) {
        throw new AgentRunInvariantError(
          'An Effect-result continuation cannot create a new Run.'
        );
      }
      const fingerprint = effectResultContinuationAuthorityFingerprint({
        commandId: commit.commandId,
        runId: mutation.runId,
        expectedVersion: mutation.expectedVersion,
        resultingVersion: mutation.resultingVersion,
        turnId: payload.turnId,
        inputDigest: payload.inputDigest,
        snapshot: payload.payload
      });
      if (!pending.has(fingerprint)) {
        throw new AgentRunInvariantError(
          'Effect-result continuation commit is missing its in-transaction durable authority proof.'
        );
      }
      required.push(fingerprint);
    }
  }
  return required;
}

export class SqliteAgentRunTransaction implements AgentRunTransaction {
  private open = true;
  /**
   * One-shot continuation checks staged by AgentRunCommandService.  The exact
   * durable body comparison is performed from the matching commit mutation,
   * while this transaction still owns the same BEGIN IMMEDIATE boundary.
   */
  private readonly pendingEffectResultContinuationChecks = new Set<string>();

  public constructor(
    private readonly database: DatabaseSync,
    private readonly payloadCodec: AgentPersistencePayloadCodec,
    private readonly effectInputDigester: AgentEffectInputDigester
  ) {}

  public close(): void {
    this.open = false;
  }

  public async loadRun(runId: string): Promise<AgentRun | null> {
    this.assertOpen();
    const row = this.database.prepare(
      `SELECT run_id, version, state_status, aggregate_json,
              created_at, updated_at
       FROM agent_v3_runs
       WHERE run_id=?`
    ).get(runId) as AgentRunRow | undefined;
    return row === undefined ? null : parseRunRow(row, 'agent_v3_runs');
  }

  public async assertEffectResultContinuationAuthority(
    check: AgentEffectResultContinuationAuthorityCheck
  ): Promise<void> {
    this.assertOpen();
    assertEffectResultContinuationAuthorityCheck(check);
    const row = this.database.prepare(
      `SELECT run_id, version, state_status, aggregate_json,
              created_at, updated_at
       FROM agent_v3_runs
       WHERE run_id=?`
    ).get(check.runId) as AgentRunRow | undefined;
    const current = row === undefined ? null : parseRunRow(row, 'agent_v3_runs');
    if (current === null || current.version !== check.expectedVersion) {
      throw new AgentRunVersionConflictError(
        check.runId,
        check.expectedVersion,
        current?.version ?? null
      );
    }
    if (
      check.resultingVersion !== check.expectedVersion + 1
      || current.state.status !== 'running'
      || current.turns.some((turn) => turn.turnId === check.turnId)
    ) {
      throw new AgentRunInvariantError(
        'Effect-result continuation authority must identify one fresh next Run version and Turn.'
      );
    }
    this.pendingEffectResultContinuationChecks.add(
      effectResultContinuationAuthorityFingerprint(check)
    );
  }

  public async loadPlanVersion(
    reference: AgentPlanReference
  ): Promise<AgentPlanVersionCommit | null> {
    this.assertOpen();
    const row = this.database.prepare(
      `SELECT * FROM agent_v3_plan_versions
       WHERE plan_id=? AND plan_version=?`
    ).get(reference.planId, reference.version) as AgentPlanVersionRow | undefined;
    if (row === undefined) return null;
    if (row.content_hash !== reference.contentHash) {
      throw storageCorruption(
        `agent_v3_plan_versions:${reference.planId}:${String(reference.version)}:hash_mismatch`
      );
    }
    const payload = decodePayload(this.payloadCodec, row.codec_id, row.payload_json, {
      kind: 'plan_payload',
      runId: row.run_id,
      commandId: row.command_id,
      runVersion: row.run_version,
      planId: row.plan_id,
      planVersion: row.plan_version,
      contentHash: row.content_hash
    }, `agent_v3_plan_versions:${row.plan_id}:${String(row.plan_version)}`);
    if (await sha256AgentControlData(payload) !== row.content_hash) {
      throw storageCorruption(
        `agent_v3_plan_versions:${row.plan_id}:${String(row.plan_version)}:payload_hash_mismatch`
      );
    }
    return {
      ref: {
        planId: row.plan_id,
        version: row.plan_version,
        contentHash: row.content_hash
      },
      runId: row.run_id,
      payload,
      createdAt: row.created_at
    };
  }

  public async loadBudgetSnapshot(grantId: string): Promise<AgentBudgetSnapshot | null> {
    this.assertOpen();
    return loadBudgetSnapshotRecord(this.database, grantId);
  }

  public async loadDelegationByChild(
    childRunId: string
  ): Promise<AgentDelegationRecord | null> {
    this.assertOpen();
    const row = this.database.prepare(
      'SELECT * FROM agent_v3_delegations WHERE child_run_id=?'
    ).get(childRunId) as AgentDelegationRow | undefined;
    return row === undefined
      ? null
      : decodeDelegationRecord(this.database, this.payloadCodec, row);
  }

  public async listDelegationsByParent(
    parentRunId: string
  ): Promise<readonly AgentDelegationRecord[]> {
    this.assertOpen();
    const rows = this.database.prepare(
      `SELECT * FROM agent_v3_delegations
       WHERE parent_run_id=? ORDER BY child_run_id`
    ).all(parentRunId) as unknown as AgentDelegationRow[];
    return Promise.all(rows.map((row) =>
      decodeDelegationRecord(this.database, this.payloadCodec, row)
    ));
  }

  public async loadChildTerminal(
    delegationId: string
  ): Promise<AgentChildTerminalCommit | null> {
    this.assertOpen();
    const row = this.database.prepare(
      'SELECT * FROM agent_v3_child_terminals WHERE delegation_id=?'
    ).get(delegationId) as AgentChildTerminalRow | undefined;
    return row === undefined ? null : parseChildTerminalRow(row);
  }

  public async loadCommittedCommand(
    commandId: string,
    artifactExpectations?: readonly AgentRunReplayArtifacts[],
    factExpectations?: AgentControlCommitFacts
  ): Promise<CommittedAgentRunCommand | null> {
    this.assertOpen();
    const committed = loadCommittedCommandRecord(this.database, commandId);
    if (committed === null) return null;
    await assertCommittedDirectiveArtifacts(
      this.database,
      this.payloadCodec,
      committed
    );
    if (artifactExpectations !== undefined) {
      assertReplayArtifactsShape(committed, artifactExpectations);
      for (const expectation of artifactExpectations) {
        const row = loadCommandRunRow(this.database, commandId, expectation.runId);
        if (row === undefined) throw storageCorruption(
          `command_run_missing:${commandId}:${expectation.runId}`
        );
        await assertPersistedArtifactsMatchMutation(
          this.database,
          this.payloadCodec,
          row,
          expectation.artifacts
        );
      }
    }
    if (factExpectations !== undefined) {
      await assertPersistedFactsMatchCommand(
        this.database,
        this.payloadCodec,
        commandId,
        factExpectations
      );
    }
    return committed;
  }

  public async commitCommand(commit: AgentRunCommandCommit): Promise<void> {
    this.assertOpen();
    assertValidCommandCommit(commit);
    const facts = commit.facts ?? EMPTY_AGENT_CONTROL_COMMIT_FACTS;
    assertAgentControlCommitFacts(facts);

    const artifactExpectations = commit.mutations.map((mutation) => ({
      runId: mutation.runId,
      artifacts: mutation.artifacts
    }));
    const committed = await this.loadCommittedCommand(
      commit.commandId,
      artifactExpectations,
      facts
    );
    if (committed !== null) {
      if (
        sameCommittedResult(committed, commit)
        && persistedExpectedVersionsMatch(this.database, commit)
      ) return;
      throw new AgentRunCommandConflictError(
        commit.commandId,
        describeCommittedMutations(committed.mutations),
        describeCommittedMutations(commit.mutations),
        'command_mismatch'
      );
    }

    const requiredContinuationChecks = requireEffectResultContinuationAuthorityChecks(
      commit,
      this.pendingEffectResultContinuationChecks
    );

    const preparedMutations = await prepareCommandMutations(
      this.database,
      this.payloadCodec,
      this.effectInputDigester,
      commit
    );
    const preparedFacts = await prepareCommandFacts(
      this.database,
      this.payloadCodec,
      commit,
      facts
    );
    for (const fingerprint of requiredContinuationChecks) {
      this.pendingEffectResultContinuationChecks.delete(fingerprint);
    }

    // Every version, identity, event, and protected artifact is validated and
    // encoded above. No durable write occurs before this point.
    for (const prepared of preparedMutations) {
      const mutation = prepared.mutation;
      if (prepared.currentRow === undefined) {
        this.insertRun(mutation.run);
        continue;
      }
      const update = this.database.prepare(
        `UPDATE agent_v3_runs
         SET version=?, state_status=?, aggregate_json=?, updated_at=?
         WHERE run_id=? AND version=?`
      ).run(
        mutation.run.version,
        mutation.run.state.status,
        serializeJson(mutation.run),
        mutation.run.updatedAt,
        mutation.runId,
        mutation.expectedVersion
      );
      if (Number(update.changes) !== 1) {
        const actual = this.database.prepare(
          'SELECT version FROM agent_v3_runs WHERE run_id=?'
        ).get(mutation.runId) as { version: number } | undefined;
        throw new AgentRunVersionConflictError(
          mutation.runId,
          mutation.expectedVersion,
          actual?.version ?? null
        );
      }
    }

    this.database.prepare(
      `INSERT INTO agent_v3_commands (
         command_id, command_digest, mutation_count, fact_count, committed_at
       ) VALUES (?, ?, ?, ?, ?)`
    ).run(
      commit.commandId,
      commit.commandDigest,
      commit.mutations.length,
      countAgentControlCommitFacts(facts),
      new Date().toISOString()
    );

    const insertCommandRun = this.database.prepare(
      `INSERT INTO agent_v3_command_runs (
         command_id, run_id, ordinal, expected_version,
         resulting_version, result_run_json
       ) VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const [ordinal, mutation] of commit.mutations.entries()) {
      insertCommandRun.run(
        commit.commandId,
        mutation.runId,
        ordinal,
        mutation.expectedVersion,
        mutation.resultingVersion,
        serializeJson(mutation.run)
      );
    }

    for (const prepared of preparedMutations) {
      persistPreparedCommitArtifacts(this.database, prepared);
    }
    persistPreparedCommandFacts(this.database, preparedFacts);

    const insertEvent = this.database.prepare(
      `INSERT INTO agent_v3_events (
         event_id, command_id, run_id, run_version, sequence,
         occurred_at, event_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const insertOutbox = this.database.prepare(
      `INSERT INTO agent_v3_outbox (
         event_id, command_id, aggregate_type, aggregate_id,
         aggregate_version, sequence, event_json, created_at, published_at
       ) VALUES (?, ?, 'agent_run', ?, ?, ?, ?, ?, NULL)`
    );
    for (const mutation of commit.mutations) {
      for (const event of mutation.events) {
        const eventJson = serializeJson(event);
        insertEvent.run(
          event.eventId,
          event.commandId,
          event.runId,
          event.runVersion,
          event.sequence,
          event.occurredAt,
          eventJson
        );
        insertOutbox.run(
          event.eventId,
          event.commandId,
          event.runId,
          event.runVersion,
          event.sequence,
          eventJson,
          event.occurredAt
        );
      }
    }
  }

  private insertRun(run: AgentRun): void {
    this.database.prepare(
      `INSERT INTO agent_v3_runs (
         run_id, version, state_status, aggregate_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      run.runId,
      run.version,
      run.state.status,
      serializeJson(run),
      run.createdAt,
      run.updatedAt
    );
  }

  private assertOpen(): void {
    if (!this.open) throw new Error('agent_v3_transaction_closed');
  }
}

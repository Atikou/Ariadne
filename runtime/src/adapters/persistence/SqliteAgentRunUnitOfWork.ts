import { DatabaseSync } from 'node:sqlite';
export type { AgentPersistenceClock, AgentKeyringAnchorVerification } from './AgentControlStorageTypes.js';
import {
  AgentRunInvariantError,
  sha256AgentControlData,
  type AgentEffectInputDigester,
  type AgentEffectPayload,
  type AgentDirectivePayloadLookup,
  type AgentDirectivePayloadReader,
  type AgentJsonValue,
  type AgentTurnInputPayloadLookup,
  type AgentTurnInputPayloadReader,
  type AgentTurnInputPayloadReference,
  type AgentTurnInputSnapshotV1,
  type AgentPersistencePayloadCodec,
  type AgentRun,
  type AgentRunCommandReceipt,
  type AgentRunCommandReceiptReader,
  type AgentRunOutboxClaimRequest,
  type AgentRunOutboxPublishRequest,
  type AgentRunOutboxStore,
  type AgentRunRecoveryPage,
  type AgentRunRecoveryPayloadReader,
  type AgentRunRecoveryQuery,
  type AgentRunRecoveryQueryRequest,
  type AgentRunCheckpoint,
  type AgentRunCheckpointReference,
  type AgentEffectPayloadReference,
  type AgentRunTransaction,
  type AgentRunUnitOfWork,
  type ClaimedAgentRunOutboxMessage
} from '@ariadne/agent-core';
import { StrictJsonAgentPersistencePayloadCodec } from './StrictJsonAgentPersistencePayloadCodec.js';
import { Sha256AgentEffectInputDigester } from './Sha256AgentEffectInputDigester.js';
import { openAgentControlDatabase } from './agentControlDbSchema.js';
import { closeOwnedSqliteDatabase } from './SqliteOwnerLease.js';
import { SqliteTransactionOwner } from './SqliteTransactionOwner.js';
import type { ShutdownContext } from '../../control/ports/ShutdownContext.js';
import type { AgentProtectedEffectResultAuthority, AgentProtectedEffectResultAuthorityRecord } from '../../control/ports/AgentToolExecution.js';
import type {
  AgentRunExecutionIntent,
  AgentRunExecutionIntentClaimRequest,
  AgentRunExecutionIntentLedger,
  AgentRunExecutionIntentReceipt,
  AgentRunExecutionIntentRecoveryPage,
  AgentRunExecutionIntentRecoveryRequest,
  AgentRunExecutionIntentStateReceipt,
  ClaimedAgentRunExecutionIntent,
  MarkAgentRunExecutionDispatchedRequest,
  SettleAgentRunExecutionIntentRequest,
  StartAgentRunExecutionDispatchRequest
} from '../../control/ports/AgentRunExecutionStarter.js';
import {
  assertAgentRunOutboxClaimRequest,
  assertAgentRunOutboxPublishRequest,
  claimPendingAgentRunOutbox,
  countUnpublishedAgentRunOutbox,
  markAgentRunOutboxPublished,
  recoverAbandonedAgentOutboxClaims
} from './agent-control/outbox/SqliteAgentRunOutboxStore.js';
import { SqliteAgentExecutionIntentStore } from './agent-control/execution-intent/SqliteAgentExecutionIntentStore.js';
import {
  type AgentCommandRunRow,
  type AgentCommittedMutationRow,
  type AgentDirectivePayloadRow,
  type AgentKeyringAnchorVerification,
  type AgentPersistenceClock,
  type AgentRunRow
} from './AgentControlStorageTypes.js';
import { verifyExactAdmittedRunForExecution } from './AgentControlExecutionAdmission.js';
import { loadCommittedCommandRecord } from './AgentControlCommandJournal.js';
import { assertCommittedDirectiveArtifacts } from './AgentControlPayloadReplay.js';
import {
  assertDirectivePayloadLookup,
  assertRecoveryQueryRequest,
  isCommandDigest,
  parseRunRow,
  parseStoredRun,
  storageCorruption
} from './AgentControlStorageValidation.js';
import { loadActiveRuns } from './AgentControlRecoveryReader.js';
import {
  effectPayloadReference,
  loadCheckpointPayload,
  loadEffectInputPayload,
  loadEffectResultPayload,
  loadTurnInputPayload
} from './AgentControlPayloadReader.js';
import { decodePayload, loadEffectPayloadRow } from './AgentControlPayloadCodec.js';
import { assertKeyringAnchorVerification, verifyOrInitializeKeyringAnchor } from './AgentControlKeyring.js';
import { SqliteAgentRunTransaction } from './SqliteAgentRunTransaction.js';

export {
  AgentRunExecutionIntentStoreError
} from './agent-control/execution-intent/SqliteAgentExecutionIntentStore.js';

const SYSTEM_CLOCK: AgentPersistenceClock = {
  now: () => new Date()
};

/**
 * SQLite implementation of the Agent Core write boundary.
 *
 * Every callback owns one `BEGIN IMMEDIATE` transaction. AgentRun aggregate,
 * committed command result, events, and outbox rows are either all committed
 * or all rolled back. The adapter writes only the `agent_v3_*` tables.
 */
export class SqliteAgentRunUnitOfWork
implements
AgentRunUnitOfWork,
AgentRunCommandReceiptReader,
AgentRunRecoveryQuery,
AgentRunRecoveryPayloadReader,
AgentTurnInputPayloadReader,
AgentDirectivePayloadReader,
AgentRunOutboxStore,
AgentRunExecutionIntentLedger,
AgentProtectedEffectResultAuthority {
  private readonly database: DatabaseSync;
  private readonly executionIntents: SqliteAgentExecutionIntentStore;
  private readonly transactionOwner: SqliteTransactionOwner;

  public constructor(
    dataRoot: string,
    private readonly payloadCodec: AgentPersistencePayloadCodec =
      new StrictJsonAgentPersistencePayloadCodec(),
    private readonly clock: AgentPersistenceClock = SYSTEM_CLOCK,
    private readonly effectInputDigester: AgentEffectInputDigester =
      new Sha256AgentEffectInputDigester()
  ) {
    const { database, databasePath, ownerLease } = openAgentControlDatabase(dataRoot);
    this.executionIntents = new SqliteAgentExecutionIntentStore(
      database,
      (intent) => verifyExactAdmittedRunForExecution(database, this.payloadCodec, intent)
    );
    try {
      recoverAbandonedAgentOutboxClaims(database);
      this.executionIntents.recoverAbandonedClaims();
    } catch (error) {
      try {
        closeOwnedSqliteDatabase(database, ownerLease);
      } catch {
        // The recovery error remains authoritative; uncertain close retains
        // the process-owner fence through closeOwnedSqliteDatabase.
      }
      throw error;
    }
    this.database = database;
    this.transactionOwner = new SqliteTransactionOwner(
      database,
      databasePath,
      ownerLease,
      {
        shutdownRequestedCode: 'agent_v3_shutdown_requested',
        closedCode: 'agent_v3_unit_of_work_closed',
        shutdownConflictCode: 'agent_v3_shutdown_context_conflict',
        transactionActiveCode: 'agent_v3_transaction_already_active',
        shutdownDeadlineCode: 'agent_v3_shutdown_deadline_exceeded'
      }
    );
  }

  public transaction<T>(
    operation: (
      transaction: AgentRunTransaction,
      shutdownSignal: AbortSignal
    ) => Promise<T>
  ): Promise<T> {
    return this.scheduleOperation((signal) => this.executeTransaction(operation, signal));
  }

  public async loadCommittedCommandReceipt(
    commandId: string
  ): Promise<AgentRunCommandReceipt | null> {
    if (commandId.length === 0) {
      throw new AgentRunInvariantError('Command receipt lookup requires a non-empty command ID.');
    }
    return this.scheduleOperation((signal) => this.executeDatabaseTransaction(
      'read',
      async () => {
        const committed = loadCommittedCommandRecord(this.database, commandId);
        if (committed === null) return null;
        await assertCommittedDirectiveArtifacts(
          this.database,
          this.payloadCodec,
          committed
        );
        return {
          commandId: committed.commandId,
          mutations: committed.mutations
        };
      },
      signal
    ));
  }

  /**
   * Loads one exact historical aggregate version from its immutable command
   * result. The mutable latest-run row is deliberately not consulted.
   */
  public async loadRunVersion(
    runId: string,
    version: number
  ): Promise<AgentRun | null> {
    if (
      runId.trim().length === 0
      || !Number.isSafeInteger(version)
      || version <= 0
    ) {
      throw new AgentRunInvariantError(
        'Historical Run lookup requires a non-empty Run ID and a positive safe version.'
      );
    }
    return this.scheduleOperation((signal) => this.executeDatabaseTransaction(
      'read',
      async () => {
        const row = this.database.prepare(
          `SELECT command.command_id, command.command_digest,
                  command.mutation_count,
                  command_run.run_id, command_run.ordinal,
                  command_run.expected_version,
                  command_run.resulting_version,
                  command_run.result_run_json
           FROM agent_v3_command_runs AS command_run
           INNER JOIN agent_v3_commands AS command
             ON command.command_id=command_run.command_id
           WHERE command_run.run_id=? AND command_run.resulting_version=?`
        ).get(runId, version) as AgentCommittedMutationRow | undefined;
        if (row === undefined) return null;
        if (row.run_id !== runId || row.resulting_version !== version) {
          throw storageCorruption(
            `historical_run_identity_mismatch:${runId}:${String(version)}`
          );
        }
        if (!isCommandDigest(row.command_digest)) {
          throw storageCorruption(
            `command_digest_invalid:${row.command_id}`
          );
        }
        return parseStoredRun(
          row.result_run_json,
          row.run_id,
          row.resulting_version,
          `agent_v3_command_runs:${row.command_id}:${row.run_id}`
        );
      },
      signal
    ));
  }

  public async listActiveRuns(
    request: AgentRunRecoveryQueryRequest = {}
  ): Promise<AgentRunRecoveryPage> {
    assertRecoveryQueryRequest(request);
    return this.scheduleOperation((signal) => this.executeDatabaseTransaction(
      'read',
      () => loadActiveRuns(this.database, this.payloadCodec, request),
      signal
    ));
  }

  public async loadCheckpoint(
    reference: AgentRunCheckpointReference
  ): Promise<AgentRunCheckpoint> {
    return this.scheduleOperation((signal) => this.executeDatabaseTransaction(
      'read',
      () => loadCheckpointPayload(this.database, this.payloadCodec, reference),
      signal
    ));
  }

  public async loadTurnInputPayload(
    reference: AgentTurnInputPayloadLookup | AgentTurnInputPayloadReference
  ): Promise<AgentTurnInputSnapshotV1> {
    return this.scheduleOperation((signal) => this.executeDatabaseTransaction(
      'read',
      () => loadTurnInputPayload(this.database, this.payloadCodec, reference),
      signal
    ));
  }

  public async loadEffectInput(
    reference: AgentEffectPayloadReference
  ): Promise<Omit<AgentEffectPayload, 'result'>> {
    return this.scheduleOperation((signal) => this.executeDatabaseTransaction(
      'read',
      () => loadEffectInputPayload(
        this.database,
        this.payloadCodec,
        this.effectInputDigester,
        reference
      ),
      signal
    ));
  }

  /**
   * Execution-time lookup by the exact aggregate/effect identity. The decoded
   * input is still verified against its durable digest before it leaves the
   * persistence adapter.
   */
  public async loadEffectExecutionInput(
    runId: string,
    effectId: string
  ): Promise<Omit<AgentEffectPayload, 'result'>> {
    if (runId.length === 0 || effectId.length === 0) {
      throw new AgentRunInvariantError(
        'Effect execution input lookup requires non-empty Run and Effect IDs.'
      );
    }
    return this.scheduleOperation((signal) => this.executeDatabaseTransaction(
      'read',
      async () => {
        const row = loadEffectPayloadRow(this.database, runId, effectId);
        if (row === undefined) {
          throw storageCorruption(
            `agent_v3_effect_payloads:${runId}:${effectId}:missing`
          );
        }
        return loadEffectInputPayload(
          this.database,
          this.payloadCodec,
          this.effectInputDigester,
          effectPayloadReference(row)
        );
      },
      signal
    ));
  }

  public async loadEffectResult(
    reference: AgentEffectPayloadReference & { readonly hasResult: true }
  ): Promise<AgentJsonValue> {
    return this.scheduleOperation((signal) => this.executeDatabaseTransaction(
      'read',
      () => loadEffectResultPayload(this.database, this.payloadCodec, reference),
      signal
    ));
  }

  public async loadProtectedEffectResultAuthority(
    runId: string,
    effectId: string
  ): Promise<AgentProtectedEffectResultAuthorityRecord | null> {
    if (runId.length === 0 || effectId.length === 0) {
      throw new AgentRunInvariantError('Protected Effect result identity is required.');
    }
    return this.scheduleOperation((signal) => this.executeDatabaseTransaction(
      'read',
      async () => {
        const runRow = this.database.prepare(
          `SELECT run_id, version, state_status, aggregate_json, created_at, updated_at
           FROM agent_v3_runs WHERE run_id=?`
        ).get(runId) as AgentRunRow | undefined;
        if (runRow === undefined) return null;
        const run = parseRunRow(runRow, 'agent_v3_runs:protected_effect_result');
        const effect = run.effects.find((candidate) => candidate.effectId === effectId);
        if (
          effect === undefined
          || (effect.state.status !== 'succeeded' && effect.state.status !== 'failed')
        ) return null;
        const payloadRow = loadEffectPayloadRow(this.database, runId, effectId);
        if (payloadRow === undefined) return null;
        const reference = effectPayloadReference(payloadRow);
        if (!reference.hasResult || reference.inputDigest !== effect.inputDigest) return null;
        return {
          runId,
          workspaceId: run.binding.workspace.workspaceId,
          effectId,
          toolCallId: effect.toolCallId,
          status: effect.state.status,
          tool: { ...effect.tool },
          result: await loadEffectResultPayload(this.database, this.payloadCodec, reference)
        };
      },
      signal
    ));
  }

  public async loadDirectivePayload(
    reference: AgentDirectivePayloadLookup
  ): Promise<AgentJsonValue> {
    assertDirectivePayloadLookup(reference);
    return this.scheduleOperation((signal) => this.executeDatabaseTransaction(
      'read',
      async () => {
        const row = this.database.prepare(
          'SELECT * FROM agent_v3_directive_payloads WHERE artifact_id=?'
        ).get(reference.artifactId) as AgentDirectivePayloadRow | undefined;
        if (row === undefined) {
          throw storageCorruption(
            `agent_v3_directive_payloads:${reference.artifactId}:missing`
          );
        }
        const payload = decodePayload(this.payloadCodec, row.codec_id, row.payload_json, {
          kind: 'directive_response',
          runId: row.run_id,
          commandId: row.command_id,
          runVersion: row.run_version,
          directiveDigest: row.directive_digest,
          contentHash: row.content_digest
        }, `agent_v3_directive_payloads:${row.artifact_id}`);
        if (
          row.run_id !== reference.runId
          || row.artifact_id !== reference.artifactId
          || row.payload_kind !== reference.kind
          || row.directive_digest !== reference.directiveDigest
          || row.content_digest !== reference.contentDigest
          || await sha256AgentControlData(payload) !== reference.contentDigest
        ) {
          throw storageCorruption(
            `agent_v3_directive_payloads:${reference.artifactId}:lookup_mismatch`
          );
        }
        return payload;
      },
      signal
    ));
  }

  public async startExecutionIntent(
    intent: AgentRunExecutionIntent,
    callerSignal: AbortSignal
  ): Promise<AgentRunExecutionIntentReceipt> {
    callerSignal.throwIfAborted();
    return this.scheduleOperation((shutdownSignal) => this.executeDatabaseTransaction(
      'write',
      async () => {
        callerSignal.throwIfAborted();
        return this.executionIntents.start(intent, callerSignal);
      },
      shutdownSignal
    ));
  }

  public async claimPendingExecutionIntents(
    request: AgentRunExecutionIntentClaimRequest
  ): Promise<readonly ClaimedAgentRunExecutionIntent[]> {
    return this.scheduleOperation((signal) => this.executeDatabaseTransaction(
      'write',
      async () => {
        const claimedAt = this.clock.now().toISOString();
        const leaseExpiresAt = new Date(
          Date.parse(claimedAt) + request.leaseMs
        ).toISOString();
        return this.executionIntents.claimPending(
          request,
          claimedAt,
          leaseExpiresAt
        );
      },
      signal
    ));
  }

  public async listExecutionIntentRecovery(
    request: AgentRunExecutionIntentRecoveryRequest = {}
  ): Promise<AgentRunExecutionIntentRecoveryPage> {
    return this.scheduleOperation((signal) => this.executeDatabaseTransaction(
      'read',
      () => this.executionIntents.listRecovery(request),
      signal
    ));
  }

  public async markExecutionDispatchStarted(
    request: StartAgentRunExecutionDispatchRequest
  ): Promise<AgentRunExecutionIntentStateReceipt> {
    return this.scheduleOperation((signal) => this.executeDatabaseTransaction(
      'write',
      () => this.executionIntents.markDispatchStarted(
        request,
        this.clock.now().toISOString()
      ),
      signal
    ));
  }

  public async markExecutionDispatched(
    request: MarkAgentRunExecutionDispatchedRequest
  ): Promise<AgentRunExecutionIntentStateReceipt> {
    return this.scheduleOperation((signal) => this.executeDatabaseTransaction(
      'write',
      () => this.executionIntents.markDispatched(
        request,
        this.clock.now().toISOString()
      ),
      signal
    ));
  }

  public async settleExecutionIntent(
    request: SettleAgentRunExecutionIntentRequest
  ): Promise<AgentRunExecutionIntentStateReceipt> {
    return this.scheduleOperation((signal) => this.executeDatabaseTransaction(
      'write',
      () => this.executionIntents.settle(
        request,
        this.clock.now().toISOString()
      ),
      signal
    ));
  }

  public async claimPending(
    request: AgentRunOutboxClaimRequest
  ): Promise<readonly ClaimedAgentRunOutboxMessage[]> {
    assertAgentRunOutboxClaimRequest(request);
    return this.scheduleOperation((signal) => this.executeDatabaseTransaction(
      'write',
      () => {
        const claimedAt = this.clock.now().toISOString();
        const leaseExpiresAt = new Date(
          Date.parse(claimedAt) + request.leaseMs
        ).toISOString();
        return claimPendingAgentRunOutbox(
          this.database,
          request,
          claimedAt,
          leaseExpiresAt
        );
      },
      signal
    ));
  }

  public async markPublished(
    request: AgentRunOutboxPublishRequest
  ): Promise<void> {
    assertAgentRunOutboxPublishRequest(request);
    return this.scheduleOperation((signal) => this.executeDatabaseTransaction(
      'write',
      () => markAgentRunOutboxPublished(
        this.database,
        request,
        this.clock.now().toISOString()
      ),
      signal
    ));
  }

  public async countUnpublishedOutbox(): Promise<number> {
    return this.scheduleOperation((signal) => this.executeDatabaseTransaction(
      'read',
      async () => countUnpublishedAgentRunOutbox(this.database),
      signal
    ));
  }

  /**
   * Verifies the production recovery keyring against the Agent-owned rollback
   * anchor. This method may initialize an entirely empty store, but never
   * advances or repairs an existing anchor.
   */
  public async verifyOrInitializeKeyringAnchor(
    request: AgentKeyringAnchorVerification
  ): Promise<void> {
    assertKeyringAnchorVerification(request);
    return this.scheduleOperation((signal) => this.executeDatabaseTransaction(
      'write',
      () => verifyOrInitializeKeyringAnchor(this.database, request, this.clock),
      signal
    ));
  }

  /**
   * Atomically closes Agent ingress and asks every operation accepted before
   * the freeze to stop. The same signal is passed to transaction callbacks and
   * checked again immediately before SQLite commit.
   */
  public prepareShutdown(context: ShutdownContext): void {
    this.transactionOwner.prepareShutdown(context);
  }

  public close(context: ShutdownContext): Promise<void> {
    return this.transactionOwner.close(context);
  }

  private async executeTransaction<T>(
    operation: (
      transaction: AgentRunTransaction,
      shutdownSignal: AbortSignal
    ) => Promise<T>,
    shutdownSignal: AbortSignal
  ): Promise<T> {
    return this.executeDatabaseTransaction('write', async () => {
      const transaction = new SqliteAgentRunTransaction(
        this.database,
        this.payloadCodec,
        this.effectInputDigester
      );
      try {
        return await operation(transaction, shutdownSignal);
      } finally {
        transaction.close();
      }
    }, shutdownSignal);
  }

  private async executeDatabaseTransaction<T>(
    mode: 'read' | 'write',
    operation: () => Promise<T>,
    shutdownSignal: AbortSignal
  ): Promise<T> {
    return this.transactionOwner.transaction(mode, operation, shutdownSignal);
  }

  private scheduleOperation<T>(
    operation: (shutdownSignal: AbortSignal) => Promise<T>
  ): Promise<T> {
    return this.transactionOwner.schedule(operation);
  }
}

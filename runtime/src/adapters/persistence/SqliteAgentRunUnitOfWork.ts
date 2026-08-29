import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  AgentRunCommandConflictError,
  AgentRunInvariantError,
  AgentRunRecoveryConflictError,
  AgentRunVersionConflictError,
  assertAgentRunCommitArtifacts,
  assertAgentRunCommitArtifactDigests,
  assertAgentTurnInputSnapshotMatchesTerminalEffectEvidence,
  assertAgentTurnInputSnapshotMatchesTurn,
  assertAgentControlCommitFacts,
  EMPTY_AGENT_CONTROL_COMMIT_FACTS,
  countAgentControlCommitFacts,
  addAgentBudgetVectors,
  subtractAgentBudgetVectors,
  zeroAgentBudgetVector,
  agentBudgetVectorFits,
  isZeroAgentBudgetVector,
  isAgentRunInboxOnlyMutation,
  canonicalizeAgentControlData,
  sha256AgentControlData,
  summarizeAgentTurnInput,
  assertValidAgentRun,
  type AgentEffectInputDigester,
  type AgentEffectResultContinuationAuthorityCheck,
  type AgentEffectPayload,
  type AgentEffectPayloadCommit,
  type AgentDirectivePayloadCommit,
  type AgentDirectivePayloadLookup,
  type AgentDirectivePayloadReader,
  type AgentJsonValue,
  type AgentTurnInputPayloadCommit,
  type AgentTurnInputPayloadLookup,
  type AgentTurnInputPayloadReader,
  type AgentTurnInputPayloadReference,
  type AgentTurnInputSnapshotV1,
  type AgentTerminalEffectResultEvidence,
  type AgentPersistencePayloadCodec,
  type AgentPersistencePayloadContext,
  type AgentRun,
  type AgentRunCommandCommit,
  type AgentRunCommitMutation,
  type AgentRunCommitArtifacts,
  type AgentRunCommandReceipt,
  type AgentRunCommandReceiptReader,
  type AgentRunEvent,
  type AgentRunOutboxClaimRequest,
  type AgentRunOutboxPublishRequest,
  type AgentRunOutboxStore,
  type AgentRunRecoveryPage,
  type AgentRunRecoveryPayloadReader,
  type AgentRunRecoveryQuery,
  type AgentRunRecoveryQueryRequest,
  type AgentRunCheckpoint,
  type AgentRunCheckpointPayload,
  type AgentRunCheckpointReference,
  type AgentEffectPayloadReference,
  type AgentRunReplayArtifacts,
  type AgentControlCommitFacts,
  type AgentPlanReference,
  type AgentPlanVersionCommit,
  type AgentBudgetGrantCommit,
  type AgentBudgetLedgerEntryCommit,
  type AgentBudgetSnapshot,
  type AgentDelegationRecord,
  type AgentChildTerminalCommit,
  type AgentRunTransaction,
  type AgentRunUnitOfWork,
  type BlockedAgentRunRecovery,
  type ClaimedAgentRunOutboxMessage,
  type CommittedAgentRunCommand,
  type RecoverableAgentRun
} from '@ariadne/agent-core';

import { StrictJsonAgentPersistencePayloadCodec } from './StrictJsonAgentPersistencePayloadCodec.js';
import { Sha256AgentEffectInputDigester } from './Sha256AgentEffectInputDigester.js';
import {
  AGENT_CONTROL_METADATA_KEYS,
  openAgentControlDatabase
} from './agentControlDbSchema.js';
import {
  closeOwnedSqliteDatabase,
  type SqliteOwnerLease
} from './SqliteOwnerLease.js';
import type { ShutdownContext } from '../../control/ports/ShutdownContext.js';
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
  parseAgentEventRow,
  type AgentEventRow
} from './agent-control/rows/AgentEventRowMapper.js';
import {
  assertAgentRunOutboxClaimRequest,
  assertAgentRunOutboxPublishRequest,
  claimPendingAgentRunOutbox,
  countUnpublishedAgentRunOutbox,
  markAgentRunOutboxPublished,
  recoverAbandonedAgentOutboxClaims
} from './agent-control/outbox/SqliteAgentRunOutboxStore.js';
import {
  AgentRunExecutionIntentStoreError,
  SqliteAgentExecutionIntentStore
} from './agent-control/execution-intent/SqliteAgentExecutionIntentStore.js';
export {
  AgentRunExecutionIntentStoreError
} from './agent-control/execution-intent/SqliteAgentExecutionIntentStore.js';

export interface AgentPersistenceClock {
  now(): Date;
}

export interface AgentKeyringAnchorVerification {
  readonly generation: number;
  readonly activeKeyId: string;
  readonly availableKeyIds: readonly string[];
  readonly requiredCodecId: string;
}

const SYSTEM_CLOCK: AgentPersistenceClock = {
  now: () => new Date()
};

interface AgentRunRow {
  run_id: string;
  version: number;
  state_status: string;
  aggregate_json: string;
  created_at: string;
  updated_at: string;
}

interface AgentCommandRow {
  command_id: string;
  command_digest: string;
  mutation_count: number;
  fact_count: number;
  committed_at: string;
}

interface AgentPlanVersionRow {
  plan_id: string;
  plan_version: number;
  content_hash: string;
  run_id: string;
  run_version: number;
  command_id: string;
  codec_id: string;
  payload_json: string;
  created_at: string;
}

interface AgentBudgetGrantRow {
  grant_id: string;
  run_id: string;
  model_turns: number;
  tool_calls: number;
  read_calls: number;
  write_calls: number;
  shell_calls: number;
  cost_microusd: number;
  deadline_at: string;
  source_kind: 'root' | 'parent_allocation';
  parent_run_id: string | null;
  parent_grant_id: string | null;
  delegation_id: string | null;
  command_id: string;
  run_version: number;
  created_at: string;
}

interface AgentBudgetEntryRow {
  entry_id: string;
  command_id: string;
  run_id: string;
  run_version: number;
  grant_id: string;
  entry_kind: AgentBudgetLedgerEntryCommit['kind'];
  model_turns: number;
  tool_calls: number;
  read_calls: number;
  write_calls: number;
  shell_calls: number;
  cost_microusd: number;
  reservation_id: string | null;
  delegation_id: string | null;
  child_run_id: string | null;
  child_grant_id: string | null;
  occurred_at: string;
}

interface AgentDelegationRow {
  delegation_id: string;
  parent_run_id: string;
  child_run_id: string;
  parent_grant_id: string;
  child_grant_id: string;
  objective_digest: string;
  objective_codec_id: string;
  objective_payload_json: string;
  required: number;
  command_id: string;
  parent_run_version: number;
  child_run_version: number;
  created_at: string;
}

interface AgentChildTerminalRow {
  delegation_id: string;
  parent_run_id: string;
  child_run_id: string;
  child_run_version: number;
  child_status: 'completed' | 'failed' | 'cancelled';
  command_id: string;
  parent_run_version: number;
  observed_at: string;
}

interface AgentCommandRunRow {
  command_id: string;
  run_id: string;
  ordinal: number;
  expected_version: number | null;
  resulting_version: number;
  result_run_json: string;
}

interface AgentCommittedMutationRow extends AgentCommandRunRow {
  command_digest: string;
  mutation_count: number;
}

const databaseTransactionTails = new Map<string, Promise<void>>();

// A pending Promise chain is not a resource-lifetime root: V8 may collect an
// unreachable chain that can never settle, which would let DatabaseSync's
// finalizer release the owner lease. Once ingress is frozen, retain the whole
// UoW at process scope until business close and lease release both succeed.
const closingAgentRunUnits = new Set<SqliteAgentRunUnitOfWork>();

interface AgentCheckpointRow {
  run_id: string;
  checkpoint_version: number;
  run_version: number;
  command_id: string;
  codec_id: string;
  payload_json: string;
  created_at: string;
}

type AgentCheckpointMetadataRow = Omit<AgentCheckpointRow, 'codec_id' | 'payload_json'>;

interface AgentEffectPayloadRow {
  effect_id: string;
  run_id: string;
  input_digest: string;
  input_command_id: string;
  input_run_version: number;
  input_codec_id: string;
  input_payload_json: string;
  result_command_id: string | null;
  result_run_version: number | null;
  result_codec_id: string | null;
  result_payload_json: string | null;
  created_at: string;
  updated_at: string;
}

interface AgentEffectPayloadMetadataRow {
  effect_id: string;
  run_id: string;
  input_digest: string;
  input_command_id: string;
  input_run_version: number;
  result_command_id: string | null;
  result_run_version: number | null;
  has_result: number;
  created_at: string;
  updated_at: string;
}

interface AgentDirectivePayloadRow {
  artifact_id: string;
  run_id: string;
  command_id: string;
  run_version: number;
  payload_kind: AgentDirectivePayloadCommit['kind'];
  directive_digest: string;
  content_digest: string;
  codec_id: string;
  payload_json: string;
  recorded_at: string;
}

interface AgentTurnInputPayloadRow {
  run_id: string;
  turn_id: string;
  input_digest: string;
  command_id: string;
  run_version: number;
  codec_id: string;
  payload_json: string;
  created_at: string;
}

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
AgentRunExecutionIntentLedger {
  private readonly database: DatabaseSync;
  private readonly executionIntents: SqliteAgentExecutionIntentStore;
  private readonly ownerLease: SqliteOwnerLease;
  private readonly databaseKey: string;
  private lifecycle: 'open' | 'closing' | 'closed' = 'open';
  private readonly operationAbortController = new AbortController();
  private shutdownContext: ShutdownContext | null = null;
  private lastScheduledOperation: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | null = null;

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
    const resolvedPath = path.resolve(databasePath);
    this.databaseKey = process.platform === 'win32'
      ? resolvedPath.toLowerCase()
      : resolvedPath;
    this.database = database;
    this.ownerLease = ownerLease;
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
    if (this.lifecycle === 'closed') {
      context.throwIfExpired();
      return;
    }
    if (this.lifecycle === 'open') {
      this.lifecycle = 'closing';
      closingAgentRunUnits.add(this);
      this.shutdownContext = context;
      this.operationAbortController.abort(new Error('agent_v3_shutdown_requested'));
    } else if (this.shutdownContext !== context) {
      throw new Error('agent_v3_shutdown_context_conflict');
    }
    context.throwIfExpired();
  }

  public close(context: ShutdownContext): Promise<void> {
    if (this.lifecycle === 'closed') return Promise.resolve();
    if (this.closePromise !== null) return this.closePromise;

    try {
      this.prepareShutdown(context);
    } catch (error) {
      return Promise.reject(error);
    }
    this.closePromise = this.lastScheduledOperation.then(() => {
      // Never release the process-owner fence after the absolute deadline. A
      // late or uncertain drain remains fenced until Main kills this process.
      context.throwIfExpired();
      closeOwnedSqliteDatabase(this.database, this.ownerLease);
      this.lifecycle = 'closed';
      closingAgentRunUnits.delete(this);
    });
    return this.closePromise;
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
    throwIfAgentOperationAborted(shutdownSignal);
    if (this.database.isTransaction) {
      throw new Error('agent_v3_transaction_already_active');
    }

    this.database.exec(mode === 'write' ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      const result = await operation();
      throwIfAgentOperationAborted(shutdownSignal);
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private scheduleOperation<T>(
    operation: (shutdownSignal: AbortSignal) => Promise<T>
  ): Promise<T> {
    if (this.lifecycle !== 'open') {
      return Promise.reject(new Error('agent_v3_unit_of_work_closed'));
    }
    const shutdownSignal = this.operationAbortController.signal;
    const result = scheduleDatabaseTransaction(
      this.databaseKey,
      () => operation(shutdownSignal)
    );
    this.lastScheduledOperation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

function throwIfAgentOperationAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('agent_v3_shutdown_requested');
}

function scheduleDatabaseTransaction<T>(
  databaseKey: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = databaseTransactionTails.get(databaseKey) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(
    () => undefined,
    () => undefined
  );
  databaseTransactionTails.set(databaseKey, tail);
  void tail.then(() => {
    if (databaseTransactionTails.get(databaseKey) === tail) {
      databaseTransactionTails.delete(databaseKey);
    }
  });
  return result;
}

interface AgentControlMetadataRow {
  key: string;
  value: string;
}

interface ProtectedRecoveryPayloadRow {
  source: string;
  codec_id: string;
  payload_json: string;
}

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

async function verifyOrInitializeKeyringAnchor(
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

function assertKeyringAnchorVerification(
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

class SqliteAgentRunTransaction implements AgentRunTransaction {
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

function loadCommittedCommandRecord(
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

function loadCommandRunRow(
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

function assertReplayArtifactsShape(
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

function persistedExpectedVersionsMatch(
  database: DatabaseSync,
  commit: AgentRunCommandCommit
): boolean {
  return commit.mutations.every((mutation) => {
    const row = loadCommandRunRow(database, commit.commandId, mutation.runId);
    return row?.expected_version === mutation.expectedVersion;
  });
}

function describeCommittedMutations(
  mutations: readonly { readonly runId: string; readonly resultingVersion: number }[]
): string {
  return mutations
    .map((mutation) => `${mutation.runId}@${String(mutation.resultingVersion)}`)
    .join(',');
}

interface PreparedPlanVersionFact {
  readonly fact: AgentPlanVersionCommit;
  readonly runVersion: number;
  readonly encoded: PreparedEncodedPayload;
}

interface PreparedDelegationFact {
  readonly fact: AgentControlCommitFacts['delegations'][number];
  readonly parentRunVersion: number;
  readonly childRunVersion: number;
  readonly encodedObjective: PreparedEncodedPayload;
}

interface PreparedCommandFacts {
  readonly commandId: string;
  readonly planVersions: readonly PreparedPlanVersionFact[];
  readonly planApprovals: AgentControlCommitFacts['planApprovals'];
  readonly budgetGrants: AgentControlCommitFacts['budgetGrants'];
  readonly budgetEntries: AgentControlCommitFacts['budgetEntries'];
  readonly delegations: readonly PreparedDelegationFact[];
  readonly childTerminals: AgentControlCommitFacts['childTerminals'];
  readonly mutationVersions: ReadonlyMap<string, number>;
}

async function prepareCommandFacts(
  database: DatabaseSync,
  codec: AgentPersistencePayloadCodec,
  commit: AgentRunCommandCommit,
  facts: AgentControlCommitFacts
): Promise<PreparedCommandFacts> {
  assertAgentControlCommitFacts(facts);
  const mutationVersions = new Map(
    commit.mutations.map((mutation) => [mutation.runId, mutation.resultingVersion])
  );
  const mutationRuns = new Map(
    commit.mutations.map((mutation) => [mutation.runId, mutation.run])
  );
  const requireMutationVersion = (runId: string, source: string): number => {
    const version = mutationVersions.get(runId);
    if (version === undefined) {
      throw new AgentRunInvariantError(
        `${source} must bind a Run mutation in the same command.`
      );
    }
    return version;
  };

  const preparedPlanVersions: PreparedPlanVersionFact[] = [];
  for (const fact of facts.planVersions) {
    const runVersion = requireMutationVersion(fact.runId, 'Plan version');
    const existing = database.prepare(
      `SELECT 1 FROM agent_v3_plan_versions
       WHERE plan_id=? AND plan_version=?`
    ).get(fact.ref.planId, fact.ref.version);
    if (existing !== undefined) {
      throw new AgentRunInvariantError('An immutable Plan version already exists.');
    }
    if (await sha256AgentControlData(fact.payload) !== fact.ref.contentHash) {
      throw new AgentRunRecoveryConflictError(
        fact.runId,
        'immutable_payload_conflict',
        'Protected Plan payload does not match its exact content hash.'
      );
    }
    preparedPlanVersions.push({
      fact,
      runVersion,
      encoded: encodePayload(codec, fact.payload, {
        kind: 'plan_payload',
        runId: fact.runId,
        commandId: commit.commandId,
        runVersion,
        planId: fact.ref.planId,
        planVersion: fact.ref.version,
        contentHash: fact.ref.contentHash
      })
    });
  }

  for (const approval of facts.planApprovals) {
    const runVersion = requireMutationVersion(approval.runId, 'Plan approval');
    const run = mutationRuns.get(approval.runId);
    const persisted = database.prepare(
      `SELECT run_id, content_hash FROM agent_v3_plan_versions
       WHERE plan_id=? AND plan_version=?`
    ).get(approval.plan.planId, approval.plan.version) as {
      run_id: string;
      content_hash: string;
    } | undefined;
    const inCommand = facts.planVersions.find((item) =>
      item.ref.planId === approval.plan.planId
      && item.ref.version === approval.plan.version
    );
    if (
      run === undefined
      || runVersion !== run.version
      || (
        persisted === undefined
        && inCommand === undefined
      )
      || (persisted?.run_id ?? inCommand?.runId) !== approval.runId
      || (persisted?.content_hash ?? inCommand?.ref.contentHash)
        !== approval.plan.contentHash
    ) {
      throw new AgentRunInvariantError(
        'Plan approval must reference the exact immutable Plan and Run mutation.'
      );
    }
  }

  const knownGrantIds = new Set<string>();
  for (const grant of facts.budgetGrants) {
    requireMutationVersion(grant.runId, 'Budget grant');
    if (
      database.prepare('SELECT 1 FROM agent_v3_budget_grants WHERE grant_id=?')
        .get(grant.grantId) !== undefined
    ) {
      throw new AgentRunInvariantError('A Budget grant is immutable once created.');
    }
    const run = mutationRuns.get(grant.runId);
    if (
      run === undefined
      || run.binding.budget.grantId !== grant.grantId
      || run.binding.budget.runId !== grant.runId
      || canonicalJson(run.binding.budget.vector) !== canonicalJson(grant.vector)
      || run.binding.budget.deadlineAt !== grant.deadlineAt
      || canonicalJson(run.binding.budget.source) !== canonicalJson(grant.source)
    ) {
      throw new AgentRunInvariantError(
        'Budget grant must match the exact immutable Run binding.'
      );
    }
    knownGrantIds.add(grant.grantId);
  }

  const preparedDelegations: PreparedDelegationFact[] = [];
  for (const delegation of facts.delegations) {
    const parentRunVersion = requireMutationVersion(
      delegation.parentRunId,
      'Delegation parent'
    );
    const childRunVersion = requireMutationVersion(
      delegation.childRunId,
      'Delegation child'
    );
    const childRun = mutationRuns.get(delegation.childRunId);
    if (
      database.prepare(
        'SELECT 1 FROM agent_v3_delegations WHERE delegation_id=? OR child_run_id=?'
      ).get(delegation.delegationId, delegation.childRunId) !== undefined
      || childRun?.binding.objectiveRef.kind !== 'parent_delegation'
      || childRun.binding.objectiveRef.parentRunId !== delegation.parentRunId
      || childRun.binding.objectiveRef.delegationId !== delegation.delegationId
      || childRun.binding.objectiveRef.objectiveDigest !== delegation.objectiveDigest
      || childRun.binding.budget.grantId !== delegation.childGrantId
      || childRun.binding.budget.source.kind !== 'parent_allocation'
      || childRun.binding.budget.source.parentGrantId !== delegation.parentGrantId
      || childRun.binding.budget.source.delegationId !== delegation.delegationId
    ) {
      throw new AgentRunInvariantError(
        'Delegation must match the exact child binding and same-command Runs.'
      );
    }
    if (await sha256AgentControlData(delegation.objective) !== delegation.objectiveDigest) {
      throw new AgentRunRecoveryConflictError(
        delegation.childRunId,
        'immutable_payload_conflict',
        'Protected child objective does not match its exact digest.'
      );
    }
    preparedDelegations.push({
      fact: delegation,
      parentRunVersion,
      childRunVersion,
      encodedObjective: encodePayload(codec, delegation.objective, {
        kind: 'delegation_objective',
        runId: delegation.childRunId,
        commandId: commit.commandId,
        runVersion: childRunVersion,
        delegationId: delegation.delegationId,
        objectiveDigest: delegation.objectiveDigest
      })
    });
  }

  for (const terminal of facts.childTerminals) {
    requireMutationVersion(terminal.parentRunId, 'Child terminal parent');
    const delegation = database.prepare(
      `SELECT parent_run_id, child_run_id FROM agent_v3_delegations
       WHERE delegation_id=?`
    ).get(terminal.delegationId) as {
      parent_run_id: string;
      child_run_id: string;
    } | undefined;
    const inCommand = facts.delegations.find(
      (item) => item.delegationId === terminal.delegationId
    );
    const childRow = database.prepare(
      `SELECT 1 AS present FROM agent_v3_command_runs
       WHERE run_id=? AND resulting_version=?`
    ).get(terminal.childRunId, terminal.childRunVersion) as { present: number } | undefined;
    const childCurrent = database.prepare(
      `SELECT run_id, version, state_status, aggregate_json, created_at, updated_at
       FROM agent_v3_runs WHERE run_id=?`
    ).get(terminal.childRunId) as AgentRunRow | undefined;
    const child = childCurrent === undefined
      ? null
      : parseRunRow(childCurrent, 'agent_v3_runs');
    if (
      (delegation?.parent_run_id ?? inCommand?.parentRunId) !== terminal.parentRunId
      || (delegation?.child_run_id ?? inCommand?.childRunId) !== terminal.childRunId
      || child === null
      || child.version !== terminal.childRunVersion
      || child.state.status !== terminal.childStatus
      || childRow === undefined
    ) {
      throw new AgentRunInvariantError(
        'Child terminal fact must bind an exact historical terminal Run version.'
      );
    }
  }

  await assertBudgetFactsBalanced(database, facts, mutationRuns, knownGrantIds);

  return {
    commandId: commit.commandId,
    planVersions: preparedPlanVersions,
    planApprovals: facts.planApprovals,
    budgetGrants: facts.budgetGrants,
    budgetEntries: facts.budgetEntries,
    delegations: preparedDelegations,
    childTerminals: facts.childTerminals,
    mutationVersions
  };
}

async function assertBudgetFactsBalanced(
  database: DatabaseSync,
  facts: AgentControlCommitFacts,
  mutationRuns: ReadonlyMap<string, AgentRun>,
  _knownGrantIds: ReadonlySet<string>
): Promise<void> {
  const grants = new Map<string, AgentBudgetGrantCommit>();
  const states = new Map<string, MutableBudgetState>();
  for (const grant of facts.budgetGrants) {
    grants.set(grant.grantId, grant);
    states.set(grant.grantId, createNewBudgetState(grant));
    if (grant.source.kind === 'parent_allocation') {
      const source = grant.source;
      const parent = facts.budgetGrants.find(
        (item) => item.grantId === source.parentGrantId
      ) ?? loadBudgetGrantRecord(database, source.parentGrantId);
      if (parent === null || parent.runId !== source.parentRunId) {
        throw new AgentRunInvariantError('Child Budget grant has no exact parent grant.');
      }
    }
  }

  const stateFor = (grantId: string): MutableBudgetState => {
    const existing = states.get(grantId);
    if (existing !== undefined) return existing;
    const snapshot = loadBudgetSnapshotRecord(database, grantId);
    if (snapshot === null) {
      throw new AgentRunInvariantError('Budget ledger entry references a missing grant.');
    }
    const state = mutableBudgetState(snapshot);
    states.set(grantId, state);
    grants.set(grantId, snapshot.grant);
    return state;
  };

  const ordered = [...facts.budgetEntries].sort((left, right) => {
    const rank = budgetEntryRank(left.kind) - budgetEntryRank(right.kind);
    return rank !== 0 ? rank : left.entryId < right.entryId ? -1 : 1;
  });
  for (const entry of ordered) {
    if (
      database.prepare('SELECT 1 FROM agent_v3_budget_entries WHERE entry_id=?')
        .get(entry.entryId) !== undefined
    ) {
      throw new AgentRunInvariantError('Budget ledger entry IDs are immutable.');
    }
    const state = stateFor(entry.grantId);
    const grant = grants.get(entry.grantId)!;
    if (entry.runId !== grant.runId || !mutationRuns.has(entry.runId)) {
      throw new AgentRunInvariantError(
        'Budget ledger entry must bind its grant owner Run mutation.'
      );
    }
    switch (entry.kind) {
      case 'root_grant':
        if (
          grant.source.kind !== 'root'
          || canonicalJson(entry.vector) !== canonicalJson(grant.vector)
        ) {
          throw new AgentRunInvariantError('Root grant ledger entry must equal its grant.');
        }
        break;
      case 'parent_allocation': {
        if (!agentBudgetVectorFits(entry.vector, state.available)) {
          throw new AgentRunInvariantError('Sibling Budget allocation exceeds parent balance.');
        }
        const childGrant = grants.get(entry.childGrantId)
          ?? loadBudgetGrantRecord(database, entry.childGrantId);
        const delegation = facts.delegations.find(
          (item) => item.delegationId === entry.delegationId
        );
        if (
          childGrant === null
          || delegation === undefined
          || childGrant.runId !== entry.childRunId
          || canonicalJson(childGrant.vector) !== canonicalJson(entry.vector)
          || delegation.parentGrantId !== entry.grantId
          || delegation.childGrantId !== entry.childGrantId
        ) {
          throw new AgentRunInvariantError(
            'Parent allocation must match the exact child grant and Delegation.'
          );
        }
        state.available = subtractAgentBudgetVectors(
          state.available,
          entry.vector,
          'parent allocation'
        );
        state.allocated = addAgentBudgetVectors(state.allocated, entry.vector);
        break;
      }
      case 'reservation':
        if (
          isZeroAgentBudgetVector(entry.vector)
          || !agentBudgetVectorFits(entry.vector, state.available)
          || state.openReservations.has(entry.reservationId)
        ) {
          throw new AgentRunInvariantError('Budget reservation exceeds available balance.');
        }
        state.available = subtractAgentBudgetVectors(
          state.available,
          entry.vector,
          'reservation'
        );
        state.reserved = addAgentBudgetVectors(state.reserved, entry.vector);
        state.openReservations.set(entry.reservationId, entry.vector);
        break;
      case 'settlement': {
        const reserved = state.openReservations.get(entry.reservationId);
        if (reserved === undefined || !agentBudgetVectorFits(entry.vector, reserved)) {
          throw new AgentRunInvariantError('Budget settlement exceeds its reservation.');
        }
        state.reserved = subtractAgentBudgetVectors(state.reserved, reserved, 'settlement');
        state.spent = addAgentBudgetVectors(state.spent, entry.vector);
        state.available = addAgentBudgetVectors(
          state.available,
          subtractAgentBudgetVectors(reserved, entry.vector, 'settlement remainder')
        );
        state.openReservations.delete(entry.reservationId);
        break;
      }
      case 'release': {
        const reserved = state.openReservations.get(entry.reservationId);
        if (reserved === undefined || canonicalJson(reserved) !== canonicalJson(entry.vector)) {
          throw new AgentRunInvariantError('Budget release must match its exact reservation.');
        }
        state.reserved = subtractAgentBudgetVectors(state.reserved, reserved, 'release');
        state.available = addAgentBudgetVectors(state.available, reserved);
        state.openReservations.delete(entry.reservationId);
        break;
      }
      case 'child_release': {
        const allocation = database.prepare(
          `SELECT * FROM agent_v3_budget_entries
           WHERE grant_id=? AND delegation_id=? AND entry_kind='parent_allocation'`
        ).get(entry.grantId, entry.delegationId) as AgentBudgetEntryRow | undefined;
        const terminal = facts.childTerminals.find(
          (item) => item.delegationId === entry.delegationId
        );
        const childSnapshot = loadBudgetSnapshotRecord(database, entry.childGrantId);
        if (
          allocation === undefined
          || terminal === undefined
          || childSnapshot === null
          || childSnapshot.openReservations.length > 0
          || canonicalJson(entry.vector) !== canonicalJson(childSnapshot.available)
          || !agentBudgetVectorFits(entry.vector, state.allocated)
        ) {
          throw new AgentRunInvariantError(
            'Child release requires an exact terminal child with no open reservation.'
          );
        }
        state.allocated = subtractAgentBudgetVectors(
          state.allocated,
          entry.vector,
          'child release'
        );
        state.available = addAgentBudgetVectors(state.available, entry.vector);
        break;
      }
    }
  }
}

interface MutableBudgetState {
  available: AgentBudgetSnapshot['available'];
  reserved: AgentBudgetSnapshot['reserved'];
  spent: AgentBudgetSnapshot['spent'];
  allocated: AgentBudgetSnapshot['allocated'];
  readonly openReservations: Map<string, AgentBudgetSnapshot['available']>;
}

function createNewBudgetState(grant: AgentBudgetGrantCommit): MutableBudgetState {
  return {
    available: { ...grant.vector },
    reserved: zeroAgentBudgetVector(),
    spent: zeroAgentBudgetVector(),
    allocated: zeroAgentBudgetVector(),
    openReservations: new Map()
  };
}

function mutableBudgetState(snapshot: AgentBudgetSnapshot): MutableBudgetState {
  return {
    available: { ...snapshot.available },
    reserved: { ...snapshot.reserved },
    spent: { ...snapshot.spent },
    allocated: { ...snapshot.allocated },
    openReservations: new Map(snapshot.openReservations.map((item) => [
      item.reservationId,
      { ...item.vector }
    ]))
  };
}

function budgetEntryRank(kind: AgentBudgetLedgerEntryCommit['kind']): number {
  switch (kind) {
    case 'root_grant': return 0;
    case 'parent_allocation': return 1;
    case 'reservation': return 2;
    case 'settlement':
    case 'release': return 3;
    case 'child_release': return 4;
  }
}

function persistPreparedCommandFacts(
  database: DatabaseSync,
  prepared: PreparedCommandFacts
): void {
  const insertPlan = database.prepare(
    `INSERT INTO agent_v3_plan_versions (
       plan_id, plan_version, content_hash, run_id, run_version,
       command_id, codec_id, payload_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const item of prepared.planVersions) {
    insertPlan.run(
      item.fact.ref.planId,
      item.fact.ref.version,
      item.fact.ref.contentHash,
      item.fact.runId,
      item.runVersion,
      prepared.commandId,
      item.encoded.codecId,
      item.encoded.payloadJson,
      item.fact.createdAt
    );
  }

  const insertApproval = database.prepare(
    `INSERT INTO agent_v3_plan_approvals (
       approval_id, decision_id, run_id, checkpoint_version,
       plan_id, plan_version, content_hash, command_id, run_version, approved_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const approval of prepared.planApprovals) {
    insertApproval.run(
      approval.approvalId,
      approval.decisionId,
      approval.runId,
      approval.checkpointVersion,
      approval.plan.planId,
      approval.plan.version,
      approval.plan.contentHash,
      prepared.commandId,
      requirePreparedMutationVersion(prepared, approval.runId),
      approval.approvedAt
    );
  }

  const insertGrant = database.prepare(
    `INSERT INTO agent_v3_budget_grants (
       grant_id, run_id, model_turns, tool_calls, read_calls, write_calls,
       shell_calls, cost_microusd, deadline_at, source_kind,
       parent_run_id, parent_grant_id, delegation_id,
       command_id, run_version, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const grant of prepared.budgetGrants) {
    const source = grant.source;
    insertGrant.run(
      grant.grantId,
      grant.runId,
      grant.vector.modelTurns,
      grant.vector.toolCalls,
      grant.vector.readCalls,
      grant.vector.writeCalls,
      grant.vector.shellCalls,
      grant.vector.costMicrousd,
      grant.deadlineAt,
      source.kind,
      source.kind === 'parent_allocation' ? source.parentRunId : null,
      source.kind === 'parent_allocation' ? source.parentGrantId : null,
      source.kind === 'parent_allocation' ? source.delegationId : null,
      prepared.commandId,
      requirePreparedMutationVersion(prepared, grant.runId),
      grant.createdAt
    );
  }

  const insertEntry = database.prepare(
    `INSERT INTO agent_v3_budget_entries (
       entry_id, command_id, run_id, run_version, grant_id, entry_kind,
       model_turns, tool_calls, read_calls, write_calls, shell_calls,
       cost_microusd, reservation_id, delegation_id, child_run_id,
       child_grant_id, occurred_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const entry of prepared.budgetEntries) {
    insertEntry.run(
      entry.entryId,
      prepared.commandId,
      entry.runId,
      requirePreparedMutationVersion(prepared, entry.runId),
      entry.grantId,
      entry.kind,
      entry.vector.modelTurns,
      entry.vector.toolCalls,
      entry.vector.readCalls,
      entry.vector.writeCalls,
      entry.vector.shellCalls,
      entry.vector.costMicrousd,
      'reservationId' in entry ? entry.reservationId : null,
      'delegationId' in entry ? entry.delegationId : null,
      'childRunId' in entry ? entry.childRunId : null,
      'childGrantId' in entry ? entry.childGrantId : null,
      entry.occurredAt
    );
  }

  const insertDelegation = database.prepare(
    `INSERT INTO agent_v3_delegations (
       delegation_id, parent_run_id, child_run_id,
       parent_grant_id, child_grant_id, objective_digest,
       objective_codec_id, objective_payload_json, required,
       command_id, parent_run_version, child_run_version, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const item of prepared.delegations) {
    insertDelegation.run(
      item.fact.delegationId,
      item.fact.parentRunId,
      item.fact.childRunId,
      item.fact.parentGrantId,
      item.fact.childGrantId,
      item.fact.objectiveDigest,
      item.encodedObjective.codecId,
      item.encodedObjective.payloadJson,
      item.fact.required ? 1 : 0,
      prepared.commandId,
      item.parentRunVersion,
      item.childRunVersion,
      item.fact.createdAt
    );
  }

  const insertTerminal = database.prepare(
    `INSERT INTO agent_v3_child_terminals (
       delegation_id, parent_run_id, child_run_id, child_run_version,
       child_status, command_id, parent_run_version, observed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const terminal of prepared.childTerminals) {
    insertTerminal.run(
      terminal.delegationId,
      terminal.parentRunId,
      terminal.childRunId,
      terminal.childRunVersion,
      terminal.childStatus,
      prepared.commandId,
      requirePreparedMutationVersion(prepared, terminal.parentRunId),
      terminal.observedAt
    );
  }
}

function requirePreparedMutationVersion(
  prepared: PreparedCommandFacts,
  runId: string
): number {
  const version = prepared.mutationVersions.get(runId);
  if (version === undefined) {
    throw new AgentRunInvariantError('Prepared control fact lost its Run mutation.');
  }
  return version;
}

async function assertPersistedFactsMatchCommand(
  database: DatabaseSync,
  codec: AgentPersistencePayloadCodec,
  commandId: string,
  expected: AgentControlCommitFacts
): Promise<void> {
  assertAgentControlCommitFacts(expected);
  const actual = await loadPersistedCommandFacts(database, codec, commandId);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new AgentRunCommandConflictError(
      commandId,
      `facts:${String(countAgentControlCommitFacts(actual))}`,
      `facts:${String(countAgentControlCommitFacts(expected))}`,
      'command_mismatch'
    );
  }
}

async function loadPersistedCommandFacts(
  database: DatabaseSync,
  codec: AgentPersistencePayloadCodec,
  commandId: string
): Promise<AgentControlCommitFacts> {
  const planRows = database.prepare(
    'SELECT * FROM agent_v3_plan_versions WHERE command_id=? ORDER BY plan_id, plan_version'
  ).all(commandId) as unknown as AgentPlanVersionRow[];
  const planVersions = await Promise.all(planRows.map(async (row) => {
    const payload = decodePayload(codec, row.codec_id, row.payload_json, {
      kind: 'plan_payload',
      runId: row.run_id,
      commandId: row.command_id,
      runVersion: row.run_version,
      planId: row.plan_id,
      planVersion: row.plan_version,
      contentHash: row.content_hash
    }, `agent_v3_plan_versions:${row.plan_id}:${String(row.plan_version)}`);
    if (await sha256AgentControlData(payload) !== row.content_hash) {
      throw storageCorruption('plan_payload_hash_mismatch');
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
  }));
  const approvalRows = database.prepare(
    `SELECT approval_id, decision_id, run_id, checkpoint_version,
            plan_id, plan_version, content_hash, approved_at
     FROM agent_v3_plan_approvals WHERE command_id=? ORDER BY approval_id`
  ).all(commandId) as unknown as Array<{
    approval_id: string;
    decision_id: string;
    run_id: string;
    checkpoint_version: number;
    plan_id: string;
    plan_version: number;
    content_hash: string;
    approved_at: string;
  }>;
  const grantRows = database.prepare(
    'SELECT * FROM agent_v3_budget_grants WHERE command_id=? ORDER BY grant_id'
  ).all(commandId) as unknown as AgentBudgetGrantRow[];
  const entryRows = database.prepare(
    'SELECT * FROM agent_v3_budget_entries WHERE command_id=? ORDER BY entry_id'
  ).all(commandId) as unknown as AgentBudgetEntryRow[];
  const delegationRows = database.prepare(
    'SELECT * FROM agent_v3_delegations WHERE command_id=? ORDER BY delegation_id'
  ).all(commandId) as unknown as AgentDelegationRow[];
  const terminalRows = database.prepare(
    'SELECT * FROM agent_v3_child_terminals WHERE command_id=? ORDER BY delegation_id'
  ).all(commandId) as unknown as AgentChildTerminalRow[];
  const delegations = await Promise.all(delegationRows.map(async (row) => {
    const decoded = await decodeDelegationRecord(database, codec, row);
    return {
      delegationId: decoded.delegationId,
      parentRunId: decoded.parentRunId,
      childRunId: decoded.childRunId,
      parentGrantId: decoded.parentGrantId,
      childGrantId: decoded.childGrantId,
      objectiveDigest: decoded.objectiveDigest,
      objective: decoded.objective,
      required: decoded.required,
      createdAt: decoded.createdAt
    };
  }));
  const facts: AgentControlCommitFacts = {
    planVersions,
    planApprovals: approvalRows.map((row) => ({
      approvalId: row.approval_id,
      decisionId: row.decision_id,
      runId: row.run_id,
      checkpointVersion: row.checkpoint_version,
      plan: {
        planId: row.plan_id,
        version: row.plan_version,
        contentHash: row.content_hash
      },
      approvedAt: row.approved_at
    })),
    budgetGrants: grantRows.map(parseBudgetGrantRow),
    budgetEntries: entryRows.map(parseBudgetEntryRow),
    delegations,
    childTerminals: terminalRows.map(parseChildTerminalRow)
  };
  assertAgentControlCommitFacts(facts);
  return facts;
}

function countPersistedCommandFacts(database: DatabaseSync, commandId: string): number {
  const row = database.prepare(
    `SELECT
       (SELECT COUNT(*) FROM agent_v3_plan_versions WHERE command_id=?)
       + (SELECT COUNT(*) FROM agent_v3_plan_approvals WHERE command_id=?)
       + (SELECT COUNT(*) FROM agent_v3_budget_grants WHERE command_id=?)
       + (SELECT COUNT(*) FROM agent_v3_budget_entries WHERE command_id=?)
       + (SELECT COUNT(*) FROM agent_v3_delegations WHERE command_id=?)
       + (SELECT COUNT(*) FROM agent_v3_child_terminals WHERE command_id=?) AS count`
  ).get(commandId, commandId, commandId, commandId, commandId, commandId) as {
    count: number;
  };
  return Number(row.count);
}

function loadBudgetGrantRecord(
  database: DatabaseSync,
  grantId: string
): AgentBudgetGrantCommit | null {
  const row = database.prepare(
    'SELECT * FROM agent_v3_budget_grants WHERE grant_id=?'
  ).get(grantId) as AgentBudgetGrantRow | undefined;
  return row === undefined ? null : parseBudgetGrantRow(row);
}

function loadBudgetSnapshotRecord(
  database: DatabaseSync,
  grantId: string
): AgentBudgetSnapshot | null {
  const grant = loadBudgetGrantRecord(database, grantId);
  if (grant === null) return null;
  const rows = database.prepare(
    `SELECT * FROM agent_v3_budget_entries
     WHERE grant_id=? ORDER BY occurred_at, entry_id`
  ).all(grantId) as unknown as AgentBudgetEntryRow[];
  let spent = zeroAgentBudgetVector();
  let allocated = zeroAgentBudgetVector();
  const reservations = new Map<string, AgentBudgetSnapshot['available']>();
  let rootEntries = 0;
  const releasedDelegations = new Set<string>();
  const allocatedDelegations = new Map<string, AgentBudgetSnapshot['available']>();
  for (const row of rows) {
    const entry = parseBudgetEntryRow(row);
    switch (entry.kind) {
      case 'root_grant':
        rootEntries += 1;
        if (canonicalJson(entry.vector) !== canonicalJson(grant.vector)) {
          throw storageCorruption(`agent_v3_budget_entries:${entry.entryId}:root_mismatch`);
        }
        break;
      case 'parent_allocation':
        if (allocatedDelegations.has(entry.delegationId)) {
          throw storageCorruption(`agent_v3_budget_entries:${entry.entryId}:duplicate_allocation`);
        }
        allocatedDelegations.set(entry.delegationId, entry.vector);
        allocated = addAgentBudgetVectors(allocated, entry.vector);
        break;
      case 'reservation':
        if (reservations.has(entry.reservationId)) {
          throw storageCorruption(`agent_v3_budget_entries:${entry.entryId}:duplicate_reservation`);
        }
        reservations.set(entry.reservationId, entry.vector);
        break;
      case 'settlement': {
        const reserved = reservations.get(entry.reservationId);
        if (reserved === undefined || !agentBudgetVectorFits(entry.vector, reserved)) {
          throw storageCorruption(`agent_v3_budget_entries:${entry.entryId}:settlement_mismatch`);
        }
        reservations.delete(entry.reservationId);
        spent = addAgentBudgetVectors(spent, entry.vector);
        break;
      }
      case 'release': {
        const reserved = reservations.get(entry.reservationId);
        if (reserved === undefined || canonicalJson(reserved) !== canonicalJson(entry.vector)) {
          throw storageCorruption(`agent_v3_budget_entries:${entry.entryId}:release_mismatch`);
        }
        reservations.delete(entry.reservationId);
        break;
      }
      case 'child_release': {
        const allocation = allocatedDelegations.get(entry.delegationId);
        if (
          allocation === undefined
          || releasedDelegations.has(entry.delegationId)
          || !agentBudgetVectorFits(entry.vector, allocation)
        ) {
          throw storageCorruption(`agent_v3_budget_entries:${entry.entryId}:child_release_mismatch`);
        }
        releasedDelegations.add(entry.delegationId);
        allocated = subtractAgentBudgetVectors(allocated, entry.vector, 'persisted child release');
        break;
      }
    }
  }
  if (grant.source.kind === 'root' && rootEntries !== 1) {
    throw storageCorruption(`agent_v3_budget_grants:${grantId}:root_entry_missing`);
  }
  if (grant.source.kind === 'parent_allocation' && rootEntries !== 0) {
    throw storageCorruption(`agent_v3_budget_grants:${grantId}:unexpected_root_entry`);
  }
  let reserved = zeroAgentBudgetVector();
  for (const vector of reservations.values()) {
    reserved = addAgentBudgetVectors(reserved, vector);
  }
  let available: AgentBudgetSnapshot['available'];
  try {
    available = subtractAgentBudgetVectors(
      subtractAgentBudgetVectors(
        subtractAgentBudgetVectors(grant.vector, spent, 'persisted spend'),
        reserved,
        'persisted reservations'
      ),
      allocated,
      'persisted allocations'
    );
  } catch (error) {
    throw storageCorruption(`agent_v3_budget_grants:${grantId}:overdrawn`, error);
  }
  return {
    grant,
    available,
    reserved,
    spent,
    allocated,
    openReservations: [...reservations.entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([reservationId, vector]) => ({ reservationId, vector }))
  };
}

function parseBudgetGrantRow(row: AgentBudgetGrantRow): AgentBudgetGrantCommit {
  const vector = budgetVectorFromRow(row);
  const source: AgentBudgetGrantCommit['source'] = row.source_kind === 'root'
    ? { kind: 'root' }
    : {
        kind: 'parent_allocation',
        parentRunId: requireStoredText(row.parent_run_id, 'parent_run_id'),
        parentGrantId: requireStoredText(row.parent_grant_id, 'parent_grant_id'),
        delegationId: requireStoredText(row.delegation_id, 'delegation_id')
      };
  return {
    grantId: row.grant_id,
    runId: row.run_id,
    vector,
    deadlineAt: row.deadline_at,
    createdAt: row.created_at,
    source
  };
}

function parseBudgetEntryRow(row: AgentBudgetEntryRow): AgentBudgetLedgerEntryCommit {
  const base = {
    entryId: row.entry_id,
    runId: row.run_id,
    grantId: row.grant_id,
    vector: budgetVectorFromRow(row),
    occurredAt: row.occurred_at
  };
  switch (row.entry_kind) {
    case 'root_grant':
      return { ...base, kind: 'root_grant' };
    case 'reservation':
    case 'settlement':
    case 'release':
      return {
        ...base,
        kind: row.entry_kind,
        reservationId: requireStoredText(row.reservation_id, 'reservation_id')
      };
    case 'parent_allocation':
    case 'child_release':
      return {
        ...base,
        kind: row.entry_kind,
        delegationId: requireStoredText(row.delegation_id, 'delegation_id'),
        childRunId: requireStoredText(row.child_run_id, 'child_run_id'),
        childGrantId: requireStoredText(row.child_grant_id, 'child_grant_id')
      };
  }
}

function budgetVectorFromRow(row: {
  model_turns: number;
  tool_calls: number;
  read_calls: number;
  write_calls: number;
  shell_calls: number;
  cost_microusd: number;
}): AgentBudgetSnapshot['available'] {
  return {
    modelTurns: row.model_turns,
    toolCalls: row.tool_calls,
    readCalls: row.read_calls,
    writeCalls: row.write_calls,
    shellCalls: row.shell_calls,
    costMicrousd: row.cost_microusd
  };
}

async function decodeDelegationRecord(
  database: DatabaseSync,
  codec: AgentPersistencePayloadCodec,
  row: AgentDelegationRow
): Promise<AgentDelegationRecord> {
  const objective = decodePayload(
    codec,
    row.objective_codec_id,
    row.objective_payload_json,
    {
      kind: 'delegation_objective',
      runId: row.child_run_id,
      commandId: row.command_id,
      runVersion: row.child_run_version,
      delegationId: row.delegation_id,
      objectiveDigest: row.objective_digest
    },
    `agent_v3_delegations:${row.delegation_id}`
  );
  if (await sha256AgentControlData(objective) !== row.objective_digest) {
    throw storageCorruption(`agent_v3_delegations:${row.delegation_id}:objective_hash_mismatch`);
  }
  const terminalRow = database.prepare(
    'SELECT * FROM agent_v3_child_terminals WHERE delegation_id=?'
  ).get(row.delegation_id) as AgentChildTerminalRow | undefined;
  return {
    delegationId: row.delegation_id,
    parentRunId: row.parent_run_id,
    childRunId: row.child_run_id,
    parentGrantId: row.parent_grant_id,
    childGrantId: row.child_grant_id,
    objectiveDigest: row.objective_digest,
    objective,
    required: row.required === 1,
    createdAt: row.created_at,
    terminal: terminalRow === undefined ? null : parseChildTerminalRow(terminalRow)
  };
}

function parseChildTerminalRow(row: AgentChildTerminalRow): AgentChildTerminalCommit {
  return {
    delegationId: row.delegation_id,
    parentRunId: row.parent_run_id,
    childRunId: row.child_run_id,
    childRunVersion: row.child_run_version,
    childStatus: row.child_status,
    observedAt: row.observed_at
  };
}

function requireStoredText(value: string | null, field: string): string {
  if (value === null || value.length === 0) {
    throw storageCorruption(`stored_fact:${field}:missing`);
  }
  return value;
}

interface PreparedEncodedPayload {
  readonly codecId: string;
  readonly payloadJson: string;
}

interface PreparedEffectArtifact {
  readonly payload: AgentEffectPayloadCommit;
  readonly encoded: PreparedEncodedPayload;
}

interface PreparedDirectiveArtifact {
  readonly payload: AgentDirectivePayloadCommit;
  readonly encoded: PreparedEncodedPayload;
}

interface PreparedTurnInputArtifact {
  readonly payload: AgentTurnInputPayloadCommit;
  readonly encoded: PreparedEncodedPayload;
}

interface PreparedCommandMutation {
  readonly mutation: AgentRunCommitMutation;
  readonly currentRow: AgentRunRow | undefined;
  readonly checkpoint?: {
    readonly checkpointVersion: number;
    readonly createdAt: string;
    readonly encoded: PreparedEncodedPayload;
  };
  readonly turnInputs: readonly PreparedTurnInputArtifact[];
  readonly effects: readonly PreparedEffectArtifact[];
  readonly directives: readonly PreparedDirectiveArtifact[];
}

async function assertDurableEffectResultContinuationArtifacts(
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

async function assertTurnInputSnapshotMatchesDurableEffectResults(
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

async function prepareCommandMutations(
  database: DatabaseSync,
  codec: AgentPersistencePayloadCodec,
  effectInputDigester: AgentEffectInputDigester,
  commit: AgentRunCommandCommit
): Promise<readonly PreparedCommandMutation[]> {
  const prepared: PreparedCommandMutation[] = [];
  for (const mutation of commit.mutations) {
    const currentRow = database.prepare(
      `SELECT run_id, version, state_status, aggregate_json,
              created_at, updated_at
       FROM agent_v3_runs WHERE run_id=?`
    ).get(mutation.runId) as AgentRunRow | undefined;
    const current = currentRow === undefined
      ? null
      : parseRunRow(currentRow, 'agent_v3_runs');
    const actualVersion = current?.version ?? null;
    if (actualVersion !== mutation.expectedVersion) {
      throw new AgentRunVersionConflictError(
        mutation.runId,
        mutation.expectedVersion,
        actualVersion
      );
    }
    const expectedNextVersion = (actualVersion ?? 0) + 1;
    if (
      mutation.resultingVersion !== expectedNextVersion
      || mutation.run.version !== expectedNextVersion
    ) {
      throw new AgentRunInvariantError(
        'Every persisted AgentRun version must advance exactly once.'
      );
    }
    if (current !== null) {
      assertStableRunIdentity(current, mutation.run);
      assertRecoveryMaterialComplete(database, current);
      await assertStoredTurnInputsComplete(database, codec, current);
    }
    const artifacts = mutation.artifacts;
    assertAgentRunCommitArtifacts(current, mutation.run, artifacts);
    await assertAgentRunCommitArtifactDigests(current, mutation.run, artifacts);
    await assertDurableEffectResultContinuationArtifacts(
      database,
      codec,
      mutation.run,
      artifacts,
      mutation.expectedVersion
    );

    const checkpoint = artifacts.checkpoint;
    const preparedCheckpoint = checkpoint === undefined
      ? undefined
      : {
          checkpointVersion: checkpoint.checkpointVersion,
          createdAt: checkpoint.createdAt,
          encoded: encodePayload(codec, checkpoint.payload, {
            kind: 'checkpoint',
            runId: mutation.runId,
            commandId: commit.commandId,
            runVersion: mutation.resultingVersion,
            checkpointVersion: checkpoint.checkpointVersion
          })
        };
    const turnInputs: PreparedTurnInputArtifact[] = [];
    for (const payload of artifacts.turnInputPayloads) {
      if (loadTurnInputPayloadRow(database, mutation.runId, payload.turnId) !== undefined) {
        throw new AgentRunRecoveryConflictError(
          mutation.runId,
          'immutable_payload_conflict',
          `Turn input "${payload.turnId}" is already durable.`
        );
      }
      turnInputs.push({
        payload,
        encoded: encodePayload(
          codec,
          payload.payload as unknown as AgentJsonValue,
          {
            kind: 'turn_input',
            runId: mutation.runId,
            turnId: payload.turnId,
            commandId: commit.commandId,
            runVersion: mutation.resultingVersion,
            inputDigest: payload.inputDigest
          }
        )
      });
    }
    const effects: PreparedEffectArtifact[] = [];
    for (const payload of artifacts.effectPayloads) {
      const context: AgentPersistencePayloadContext = {
        kind: payload.kind === 'record_input' ? 'effect_input' : 'effect_result',
        runId: mutation.runId,
        commandId: commit.commandId,
        runVersion: mutation.resultingVersion,
        effectId: payload.effectId,
        inputDigest: payload.inputDigest
      };
      if (payload.kind === 'record_input') {
        const actualDigest = effectInputDigester.digest(payload.input, {
          runId: mutation.runId,
          effectId: payload.effectId
        });
        if (actualDigest !== payload.inputDigest) {
          throw new AgentRunRecoveryConflictError(
            mutation.runId,
            'effect_digest_mismatch',
            `Effect payload "${payload.effectId}" does not match its protected input digest.`
          );
        }
        if (loadEffectPayloadRow(database, mutation.runId, payload.effectId) !== undefined) {
          throw new AgentRunRecoveryConflictError(
            mutation.runId,
            'immutable_payload_conflict',
            `Effect input "${payload.effectId}" is already durable.`
          );
        }
        effects.push({ payload, encoded: encodePayload(codec, payload.input, context) });
        continue;
      }
      const currentPayload = loadEffectPayloadRow(
        database,
        mutation.runId,
        payload.effectId
      );
      if (currentPayload === undefined || currentPayload.input_digest !== payload.inputDigest) {
        throw new AgentRunRecoveryConflictError(
          mutation.runId,
          'effect_digest_mismatch',
          `Effect result "${payload.effectId}" has no matching persisted input.`
        );
      }
      if (currentPayload.result_command_id !== null) {
        throw new AgentRunRecoveryConflictError(
          mutation.runId,
          'immutable_payload_conflict',
          `Effect result "${payload.effectId}" is immutable once recorded.`
        );
      }
      effects.push({ payload, encoded: encodePayload(codec, payload.result, context) });
    }
    const directives: PreparedDirectiveArtifact[] = [];
    for (const payload of artifacts.directivePayloads ?? []) {
      if (
        database.prepare(
          'SELECT 1 FROM agent_v3_directive_payloads WHERE artifact_id=?'
        ).get(payload.artifactId) !== undefined
      ) {
        throw new AgentRunRecoveryConflictError(
          mutation.runId,
          'immutable_payload_conflict',
          `Directive artifact "${payload.artifactId}" is already durable.`
        );
      }
      if (await sha256AgentControlData(payload.payload) !== payload.contentDigest) {
        throw new AgentRunRecoveryConflictError(
          mutation.runId,
          'immutable_payload_conflict',
          `Directive artifact "${payload.artifactId}" content digest does not match.`
        );
      }
      directives.push({
        payload,
        encoded: encodePayload(codec, payload.payload, {
          kind: 'directive_response',
          runId: mutation.runId,
          commandId: commit.commandId,
          runVersion: mutation.resultingVersion,
          directiveDigest: payload.directiveDigest,
          contentHash: payload.contentDigest
        })
      });
    }
    assertPreparedRecoveryMaterialComplete(database, mutation, turnInputs, effects);
    prepared.push({
      mutation,
      currentRow,
      ...(preparedCheckpoint === undefined ? {} : { checkpoint: preparedCheckpoint }),
      turnInputs,
      effects,
      directives
    });
  }
  return prepared;
}

function persistPreparedCommitArtifacts(
  database: DatabaseSync,
  prepared: PreparedCommandMutation
): void {
  const mutation = prepared.mutation;
  const checkpoint = prepared.checkpoint;
  if (checkpoint !== undefined) {
    database.prepare(
      `INSERT INTO agent_v3_checkpoints (
         run_id, checkpoint_version, run_version, command_id,
         codec_id, payload_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      mutation.runId,
      checkpoint.checkpointVersion,
      mutation.resultingVersion,
      prepared.mutation.events[0]!.commandId,
      checkpoint.encoded.codecId,
      checkpoint.encoded.payloadJson,
      checkpoint.createdAt
    );
  }

  const commandId = mutation.events[0]!.commandId;
  const insertTurnInput = database.prepare(
    `INSERT INTO agent_v3_turn_inputs (
       run_id, turn_id, input_digest, command_id, run_version,
       codec_id, payload_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const item of prepared.turnInputs) {
    insertTurnInput.run(
      mutation.runId,
      item.payload.turnId,
      item.payload.inputDigest,
      commandId,
      mutation.resultingVersion,
      item.encoded.codecId,
      item.encoded.payloadJson,
      item.payload.recordedAt
    );
  }
  for (const item of prepared.effects) {
    const payload = item.payload;
    if (payload.kind === 'record_input') {
      database.prepare(
        `INSERT INTO agent_v3_effect_payloads (
           run_id, effect_id, input_digest,
           input_command_id, input_run_version,
           input_codec_id, input_payload_json,
           result_command_id, result_run_version,
           result_codec_id, result_payload_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`
      ).run(
        mutation.runId,
        payload.effectId,
        payload.inputDigest,
        commandId,
        mutation.resultingVersion,
        item.encoded.codecId,
        item.encoded.payloadJson,
        payload.recordedAt,
        payload.recordedAt
      );
      continue;
    }
    const update = database.prepare(
      `UPDATE agent_v3_effect_payloads
       SET result_command_id=?, result_run_version=?,
           result_codec_id=?, result_payload_json=?, updated_at=?
       WHERE run_id=? AND effect_id=? AND result_command_id IS NULL`
    ).run(
      commandId,
      mutation.resultingVersion,
      item.encoded.codecId,
      item.encoded.payloadJson,
      payload.recordedAt,
      mutation.runId,
      payload.effectId
    );
    if (Number(update.changes) !== 1) {
      throw new AgentRunRecoveryConflictError(
        mutation.runId,
        'immutable_payload_conflict',
        `Effect result "${payload.effectId}" was concurrently recorded.`
      );
    }
  }
  const insertDirective = database.prepare(
    `INSERT INTO agent_v3_directive_payloads (
       artifact_id, run_id, command_id, run_version, payload_kind,
       directive_digest, content_digest, codec_id, payload_json, recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const item of prepared.directives) {
    insertDirective.run(
      item.payload.artifactId,
      mutation.runId,
      commandId,
      mutation.resultingVersion,
      item.payload.kind,
      item.payload.directiveDigest,
      item.payload.contentDigest,
      item.encoded.codecId,
      item.encoded.payloadJson,
      item.payload.recordedAt
    );
  }
}

async function assertPersistedArtifactsMatchMutation(
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

function assertPreparedRecoveryMaterialComplete(
  database: DatabaseSync,
  mutation: AgentRunCommitMutation,
  preparedTurnInputs: readonly PreparedTurnInputArtifact[],
  preparedEffects: readonly PreparedEffectArtifact[]
): void {
  const preparedTurnIds = new Set(
    preparedTurnInputs.map((item) => item.payload.turnId)
  );
  for (const turn of mutation.run.turns) {
    const persisted = loadTurnInputPayloadRow(database, mutation.runId, turn.turnId);
    if (
      persisted === undefined
        ? !preparedTurnIds.has(turn.turnId)
        : persisted.input_digest !== turn.intention.inputDigest
    ) {
      throw new AgentRunRecoveryConflictError(
        mutation.runId,
        'immutable_payload_conflict',
        `Turn "${turn.turnId}" does not have an exact protected input.`
      );
    }
  }
  const preparedByEffectId = new Map(
    preparedEffects.map((item) => [item.payload.effectId, item.payload] as const)
  );
  for (const effect of mutation.run.effects) {
    const persisted = loadEffectPayloadRow(database, mutation.runId, effect.effectId);
    const prepared = preparedByEffectId.get(effect.effectId);
    const hasInput = persisted !== undefined || prepared?.kind === 'record_input';
    const inputDigest = persisted?.input_digest ?? prepared?.inputDigest;
    if (!hasInput || inputDigest !== effect.inputDigest) {
      throw new AgentRunRecoveryConflictError(
        mutation.runId,
        'effect_digest_mismatch',
        `Effect "${effect.effectId}" does not have an exact durable input.`
      );
    }
    const requiresResult = effect.state.status === 'succeeded'
      || effect.state.status === 'failed';
    const hasResult = persisted?.result_payload_json !== null
      && persisted?.result_payload_json !== undefined
      || prepared?.kind === 'record_result';
    if (requiresResult !== hasResult) {
      throw new AgentRunRecoveryConflictError(
        mutation.runId,
        'immutable_payload_conflict',
        `Effect "${effect.effectId}" has inconsistent durable result material.`
      );
    }
  }
}

function assertRecoveryMaterialComplete(database: DatabaseSync, run: AgentRun): void {
  if (
    run.state.status !== 'queued'
    && run.state.status !== 'completed'
    && run.state.status !== 'failed'
    && run.state.status !== 'cancelled'
  ) {
    const checkpoint = database.prepare(
      `SELECT run_version FROM agent_v3_checkpoints
       WHERE run_id=? AND checkpoint_version=?`
    ).get(run.runId, run.state.checkpointVersion) as { run_version: number } | undefined;
    if (
      checkpoint === undefined
      || (
        checkpoint.run_version !== run.version
        && !checkpointCoversInboxOnlyAdvance(database, run, checkpoint.run_version)
      )
    ) {
      throw new AgentRunRecoveryConflictError(
        run.runId,
        'checkpoint_mismatch',
        'The active run does not have an exact durable checkpoint.'
      );
    }
  }
  for (const effect of run.effects) {
    const payload = loadEffectPayloadRow(database, run.runId, effect.effectId);
    if (payload === undefined || payload.input_digest !== effect.inputDigest) {
      throw new AgentRunRecoveryConflictError(
        run.runId,
        'effect_digest_mismatch',
        `Effect "${effect.effectId}" does not have a matching durable input.`
      );
    }
    const requiresResult = effect.state.status === 'succeeded'
      || effect.state.status === 'failed';
    if (requiresResult !== (payload.result_payload_json !== null)) {
      throw new AgentRunRecoveryConflictError(
        run.runId,
        'immutable_payload_conflict',
        `Effect "${effect.effectId}" has inconsistent durable result material.`
      );
    }
  }
}

async function assertStoredTurnInputsComplete(
  database: DatabaseSync,
  codec: AgentPersistencePayloadCodec,
  run: AgentRun
): Promise<void> {
  const rows = database.prepare(
    'SELECT * FROM agent_v3_turn_inputs WHERE run_id=? ORDER BY turn_id'
  ).all(run.runId) as unknown as AgentTurnInputPayloadRow[];
  if (run.state.status === 'queued') {
    if (run.turns.length !== 0 || rows.length !== 0) {
      throw new AgentRunRecoveryConflictError(
        run.runId,
        'immutable_payload_conflict',
        'A queued Run must not contain Turn input snapshots.'
      );
    }
    return;
  }
  if (rows.length !== run.turns.length) {
    throw new AgentRunRecoveryConflictError(
      run.runId,
      'immutable_payload_conflict',
      'Every existing Turn requires one exact protected input snapshot.'
    );
  }
  for (const turn of run.turns) {
    const row = rows.find((candidate) => candidate.turn_id === turn.turnId);
    if (row === undefined || row.input_digest !== turn.intention.inputDigest) {
      throw new AgentRunRecoveryConflictError(
        run.runId,
        'immutable_payload_conflict',
        `Turn "${turn.turnId}" has missing or drifted protected input metadata.`
      );
    }
    try {
      const snapshot = await loadTurnInputPayload(database, codec, {
        runId: row.run_id,
        turnId: row.turn_id,
        inputDigest: row.input_digest,
        commandId: row.command_id,
        runVersion: row.run_version,
        createdAt: row.created_at
      });
      await assertAgentTurnInputSnapshotMatchesTurn(
        run,
        turn.turnId,
        turn.intention.inputDigest,
        snapshot
      );
    } catch (error) {
      throw new AgentRunRecoveryConflictError(
        run.runId,
        'immutable_payload_conflict',
        `Turn "${turn.turnId}" protected input failed integrity validation: ${
          error instanceof Error ? error.name : 'unknown_error'
        }.`
      );
    }
  }
}

function loadEffectPayloadRow(
  database: DatabaseSync,
  runId: string,
  effectId: string
): AgentEffectPayloadRow | undefined {
  return database.prepare(
    `SELECT * FROM agent_v3_effect_payloads WHERE run_id=? AND effect_id=?`
  ).get(runId, effectId) as AgentEffectPayloadRow | undefined;
}

function loadTurnInputPayloadRow(
  database: DatabaseSync,
  runId: string,
  turnId: string
): AgentTurnInputPayloadRow | undefined {
  return database.prepare(
    'SELECT * FROM agent_v3_turn_inputs WHERE run_id=? AND turn_id=?'
  ).get(runId, turnId) as AgentTurnInputPayloadRow | undefined;
}

function encodePayload(
  codec: AgentPersistencePayloadCodec,
  value: AgentJsonValue,
  context: AgentPersistencePayloadContext
): { codecId: string; payloadJson: string } {
  const encoded = codec.encode(value, context);
  if (encoded.codecId.length === 0) {
    throw new AgentRunInvariantError('Persistence payload codec IDs must be non-empty.');
  }
  assertJsonValue(encoded.payload, 'encoded.payload');
  return { codecId: encoded.codecId, payloadJson: serializeJson(encoded.payload) };
}

function decodePayload(
  codec: AgentPersistencePayloadCodec,
  codecId: string,
  payloadJson: string,
  context: AgentPersistencePayloadContext,
  source: string
): AgentJsonValue {
  try {
    const encoded = parseJson(payloadJson, source);
    assertJsonValue(encoded, `${source}.payload`);
    const decoded = codec.decode({ codecId, payload: encoded }, context);
    assertJsonValue(decoded, `${source}.decoded`);
    return decoded;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('agent_v3_storage_corruption:')) {
      throw error;
    }
    throw storageCorruption(`${source}:payload_decode_failed`, error);
  }
}

function decodeEffectColumn(
  codec: AgentPersistencePayloadCodec,
  row: AgentEffectPayloadRow,
  column: 'input' | 'result'
): AgentJsonValue {
  const isInput = column === 'input';
  const commandId = isInput ? row.input_command_id : row.result_command_id;
  const runVersion = isInput ? row.input_run_version : row.result_run_version;
  const codecId = isInput ? row.input_codec_id : row.result_codec_id;
  const payloadJson = isInput ? row.input_payload_json : row.result_payload_json;
  if (commandId === null || runVersion === null || codecId === null || payloadJson === null) {
    throw storageCorruption(
      `agent_v3_effect_payloads:${row.run_id}:${row.effect_id}:${column}_missing`
    );
  }
  return decodePayload(codec, codecId, payloadJson, {
    kind: isInput ? 'effect_input' : 'effect_result',
    runId: row.run_id,
    commandId,
    runVersion,
    effectId: row.effect_id,
    inputDigest: row.input_digest
  }, `agent_v3_effect_payloads:${row.run_id}:${row.effect_id}:${column}`);
}

function decodeTurnInputColumn(
  codec: AgentPersistencePayloadCodec,
  row: AgentTurnInputPayloadRow
): AgentTurnInputSnapshotV1 {
  const decoded = decodePayload(codec, row.codec_id, row.payload_json, {
    kind: 'turn_input',
    runId: row.run_id,
    turnId: row.turn_id,
    commandId: row.command_id,
    runVersion: row.run_version,
    inputDigest: row.input_digest
  }, `agent_v3_turn_inputs:${row.run_id}:${row.turn_id}`);
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw storageCorruption(
      `agent_v3_turn_inputs:${row.run_id}:${row.turn_id}:invalid_payload`
    );
  }
  return decoded as unknown as AgentTurnInputSnapshotV1;
}

async function assertCommittedDirectiveArtifacts(
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

async function collectControlRecoveryIssues(
  database: DatabaseSync,
  codec: AgentPersistencePayloadCodec,
  run: AgentRun
): Promise<Set<BlockedAgentRunRecovery['issues'][number]>> {
  const issues = new Set<BlockedAgentRunRecovery['issues'][number]>();
  try {
    const budget = loadBudgetSnapshotRecord(database, run.binding.budget.grantId);
    if (budget === null) {
      issues.add('missing_budget_grant');
    } else if (
      budget.grant.runId !== run.runId
      || canonicalJson(budget.grant.vector) !== canonicalJson(run.binding.budget.vector)
      || budget.grant.deadlineAt !== run.binding.budget.deadlineAt
      || canonicalJson(budget.grant.source) !== canonicalJson(run.binding.budget.source)
    ) {
      issues.add('budget_integrity_mismatch');
    }
  } catch {
    issues.add('budget_integrity_mismatch');
  }

  if (run.binding.objectiveRef.kind === 'parent_delegation') {
    const row = database.prepare(
      'SELECT * FROM agent_v3_delegations WHERE child_run_id=?'
    ).get(run.runId) as AgentDelegationRow | undefined;
    if (row === undefined) {
      issues.add('missing_delegation');
    } else {
      try {
        const delegation = await decodeDelegationRecord(database, codec, row);
        if (
          delegation.parentRunId !== run.binding.objectiveRef.parentRunId
          || delegation.delegationId !== run.binding.objectiveRef.delegationId
          || delegation.objectiveDigest !== run.binding.objectiveRef.objectiveDigest
          || delegation.childGrantId !== run.binding.budget.grantId
        ) {
          issues.add('delegation_integrity_mismatch');
        }
      } catch {
        issues.add('delegation_integrity_mismatch');
      }
    }
  }

  if (
    run.state.status === 'waiting'
    && run.state.reason === 'plan_approval'
  ) {
    const decision = run.state.decision;
    const row = database.prepare(
      `SELECT * FROM agent_v3_plan_versions
       WHERE plan_id=? AND plan_version=?`
    ).get(decision.planId, decision.planVersion) as AgentPlanVersionRow | undefined;
    if (row === undefined) {
      issues.add('missing_plan_payload');
    } else {
      try {
        const payload = decodePayload(codec, row.codec_id, row.payload_json, {
          kind: 'plan_payload',
          runId: row.run_id,
          commandId: row.command_id,
          runVersion: row.run_version,
          planId: row.plan_id,
          planVersion: row.plan_version,
          contentHash: row.content_hash
        }, `agent_v3_plan_versions:${row.plan_id}:${String(row.plan_version)}`);
        if (
          row.run_id !== run.runId
          || row.content_hash !== decision.planHash
          || await sha256AgentControlData(payload) !== decision.planHash
        ) {
          issues.add('plan_integrity_mismatch');
        }
      } catch {
        issues.add('plan_integrity_mismatch');
      }
    }
  }

  for (const turn of run.turns) {
    for (const attempt of turn.attempts) {
      if (attempt.state.status !== 'succeeded') continue;
      const directive = attempt.state.directive;
      let expected: {
        artifactId: string;
        kind: AgentDirectivePayloadCommit['kind'];
        contentDigest: string;
      } | null = null;
      if (directive.kind === 'respond') {
        expected = {
          artifactId: directive.contentRef,
          kind: 'response_content',
          contentDigest: directive.contentDigest
        };
      } else if (directive.kind === 'ask_user') {
        expected = {
          artifactId: directive.questionRef,
          kind: 'user_question',
          contentDigest: directive.questionDigest
        };
      } else if (directive.kind === 'checkpoint') {
        expected = {
          artifactId: directive.reasonRef,
          kind: 'checkpoint_reason',
          contentDigest: directive.reasonDigest
        };
      } else if (
        directive.kind === 'complete'
        && directive.outputRef !== undefined
        && directive.outputDigest !== undefined
      ) {
        expected = {
          artifactId: directive.outputRef,
          kind: 'completion_output',
          contentDigest: directive.outputDigest
        };
      } else if (directive.kind === 'fail') {
        expected = {
          artifactId: directive.messageRef,
          kind: 'failure_message',
          contentDigest: directive.messageDigest
        };
      }
      if (expected === null) continue;
      const row = database.prepare(
        'SELECT * FROM agent_v3_directive_payloads WHERE artifact_id=?'
      ).get(expected.artifactId) as AgentDirectivePayloadRow | undefined;
      if (row === undefined) {
        issues.add('missing_directive_payload');
        continue;
      }
      try {
        const payload = decodePayload(codec, row.codec_id, row.payload_json, {
          kind: 'directive_response',
          runId: row.run_id,
          commandId: row.command_id,
          runVersion: row.run_version,
          directiveDigest: row.directive_digest,
          contentHash: row.content_digest
        }, `agent_v3_directive_payloads:${row.artifact_id}`);
        if (
          row.run_id !== run.runId
          || row.payload_kind !== expected.kind
          || row.directive_digest !== attempt.state.directiveDigest
          || row.content_digest !== expected.contentDigest
          || await sha256AgentControlData(payload) !== expected.contentDigest
        ) {
          issues.add('directive_payload_mismatch');
        }
      } catch {
        issues.add('directive_payload_mismatch');
      }
    }
  }

  if (run.state.status === 'waiting_children' || run.state.status === 'cancelling') {
    try {
      const rows = database.prepare(
        `SELECT * FROM agent_v3_delegations
         WHERE parent_run_id=? ORDER BY child_run_id`
      ).all(run.runId) as unknown as AgentDelegationRow[];
      const required = rows.filter((row) => row.required === 1).map((row) => row.child_run_id);
      const terminal = rows.filter((row) =>
        row.required === 1
        && database.prepare(
          'SELECT 1 FROM agent_v3_child_terminals WHERE delegation_id=?'
        ).get(row.delegation_id) !== undefined
      ).map((row) => row.child_run_id);
      if (
        canonicalJson(required) !== canonicalJson(run.state.requiredChildRunIds)
        || canonicalJson(terminal) !== canonicalJson(run.state.terminalChildRunIds)
      ) {
        issues.add('pending_required_child_mismatch');
      }
    } catch {
      issues.add('pending_required_child_mismatch');
    }
  }
  return issues;
}

async function loadActiveRuns(
  database: DatabaseSync,
  codec: AgentPersistencePayloadCodec,
  request: AgentRunRecoveryQueryRequest
): Promise<AgentRunRecoveryPage> {
  assertActiveRunMetadataConsistent(database);
  const limit = request.limit ?? 100;
  const parameters: Array<string | number> = [];
  let cursorClause = '';
  if (request.after !== undefined) {
    cursorClause = 'AND (created_at > ? OR (created_at = ? AND run_id > ?))';
    parameters.push(
      request.after.createdAt,
      request.after.createdAt,
      request.after.runId
    );
  }
  parameters.push(limit + 1);
  const rows = database.prepare(
    `SELECT run_id, version, state_status, aggregate_json,
            created_at, updated_at
     FROM agent_v3_runs
     WHERE state_status IN (
       'queued', 'running', 'waiting', 'recovering',
       'waiting_children', 'waiting_input', 'cancelling'
     )
       ${cursorClause}
     ORDER BY created_at, run_id
     LIMIT ?`
  ).all(...parameters) as unknown as AgentRunRow[];
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const items: RecoverableAgentRun[] = [];
  for (const row of pageRows) {
    const run = parseRunRow(row, 'agent_v3_runs');
    const controlIssues = await collectControlRecoveryIssues(database, codec, run);
    if (run.state.status === 'queued') {
      const recoveryRows = database.prepare(
        `SELECT
           (SELECT COUNT(*) FROM agent_v3_checkpoints WHERE run_id=?)
             +
           (SELECT COUNT(*) FROM agent_v3_effect_payloads WHERE run_id=?) AS other_count,
           (SELECT COUNT(*) FROM agent_v3_turn_inputs WHERE run_id=?) AS turn_input_count`
      ).get(run.runId, run.runId, run.runId) as {
        other_count: number;
        turn_input_count: number;
      };
      if (
        recoveryRows.other_count === 0
        && recoveryRows.turn_input_count === 0
        && controlIssues.size === 0
      ) {
        items.push({
          ready: true,
          phase: 'queued',
          run,
          checkpoint: null,
          turnInputPayloads: [],
          effectPayloads: []
        });
      } else {
        items.push({
          ready: false,
          run,
          issues: [
            ...(recoveryRows.other_count === 0 ? [] : ['unexpected_checkpoint'] as const),
            ...(recoveryRows.turn_input_count === 0
              ? []
              : ['unexpected_turn_input'] as const),
            ...controlIssues
          ]
        });
      }
      continue;
    }

    const issues = new Set<BlockedAgentRunRecovery['issues'][number]>(controlIssues);
    const checkpoint = database.prepare(
      `SELECT run_id, checkpoint_version, run_version, command_id, created_at
       FROM agent_v3_checkpoints
       WHERE run_id=? AND checkpoint_version=?`
    ).get(run.runId, run.state.checkpointVersion) as
      AgentCheckpointMetadataRow | undefined;
    if (checkpoint === undefined) {
      issues.add('missing_checkpoint');
    } else if (
      checkpoint.run_version !== run.version
      && !checkpointCoversInboxOnlyAdvance(database, run, checkpoint.run_version)
    ) {
      issues.add('checkpoint_metadata_mismatch');
    }


    const turnInputRows = database.prepare(
      'SELECT * FROM agent_v3_turn_inputs WHERE run_id=? ORDER BY turn_id'
    ).all(run.runId) as unknown as AgentTurnInputPayloadRow[];
    const turnInputReferences: AgentTurnInputPayloadReference[] = [];
    for (const turn of run.turns) {
      const payload = turnInputRows.find((candidate) => candidate.turn_id === turn.turnId);
      if (payload === undefined) {
        issues.add('missing_turn_input');
        continue;
      }
      const expectedIntroductionVersion = (turn.intention.expectedRunVersion ?? 0) + 1;
      if (
        payload.input_digest !== turn.intention.inputDigest
        || payload.created_at !== turn.createdAt
        || payload.run_version !== expectedIntroductionVersion
      ) {
        issues.add('turn_input_digest_mismatch');
        continue;
      }
      const reference: AgentTurnInputPayloadReference = {
        runId: payload.run_id,
        turnId: payload.turn_id,
        inputDigest: payload.input_digest,
        commandId: payload.command_id,
        runVersion: payload.run_version,
        createdAt: payload.created_at
      };
      try {
        const decoded = decodeTurnInputColumn(codec, payload);
        await assertAgentTurnInputSnapshotMatchesTurn(
          run,
          turn.turnId,
          turn.intention.inputDigest,
          decoded
        );
        await loadTurnInputPayload(database, codec, reference);
        turnInputReferences.push(reference);
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        issues.add(message.includes('turn_input_cause_mismatch')
          ? 'turn_input_cause_mismatch'
          : message.includes('turn_input_catalog_mismatch')
            ? 'turn_input_catalog_mismatch'
            : 'turn_input_digest_mismatch');
      }
    }
    if (turnInputRows.some((payload) =>
      !run.turns.some((turn) => turn.turnId === payload.turn_id)
    )) {
      issues.add('unexpected_turn_input');
    }

    const effectRows = database.prepare(
      `SELECT run_id, effect_id, input_digest,
              input_command_id, input_run_version,
              result_command_id, result_run_version,
              CASE WHEN result_payload_json IS NULL THEN 0 ELSE 1 END AS has_result,
              created_at, updated_at
       FROM agent_v3_effect_payloads
       WHERE run_id=? ORDER BY effect_id`
    ).all(run.runId) as unknown as AgentEffectPayloadMetadataRow[];
    const effectReferences: AgentEffectPayloadReference[] = [];
    for (const effect of run.effects) {
      const payload = effectRows.find((candidate) => candidate.effect_id === effect.effectId);
      if (payload === undefined) {
        issues.add('missing_effect_input');
        continue;
      }
      if (payload.input_digest !== effect.inputDigest) {
        issues.add('effect_digest_mismatch');
      }
      const expectsResult = effect.state.status === 'succeeded'
        || effect.state.status === 'failed';
      const hasResult = payload.has_result === 1;
      if (expectsResult && !hasResult) issues.add('missing_effect_result');
      if (!expectsResult && hasResult) issues.add('unexpected_effect_result');
      if (hasResult) {
        if (payload.result_command_id === null || payload.result_run_version === null) {
          issues.add('missing_effect_result');
          continue;
        }
        effectReferences.push({
          runId: run.runId,
          effectId: effect.effectId,
          inputDigest: payload.input_digest,
          inputCommandId: payload.input_command_id,
          inputRunVersion: payload.input_run_version,
          hasResult: true,
          resultCommandId: payload.result_command_id,
          resultRunVersion: payload.result_run_version,
          createdAt: payload.created_at,
          updatedAt: payload.updated_at
        });
      } else {
        effectReferences.push({
          runId: run.runId,
          effectId: effect.effectId,
          inputDigest: payload.input_digest,
          inputCommandId: payload.input_command_id,
          inputRunVersion: payload.input_run_version,
          hasResult: false,
          createdAt: payload.created_at,
          updatedAt: payload.updated_at
        });
      }
    }
    if (effectRows.some((payload) =>
      !run.effects.some((effect) => effect.effectId === payload.effect_id)
    )) {
      throw storageCorruption(`agent_v3_effect_payloads:${run.runId}:orphaned_effect`);
    }

    if (issues.size > 0 || checkpoint === undefined) {
      items.push({ ready: false, run, issues: [...issues] });
    } else {
      items.push({
        ready: true,
        phase: 'resumable',
        run,
        checkpoint: checkpointReference(checkpoint),
        turnInputPayloads: turnInputReferences,
        effectPayloads: effectReferences
      });
    }
  }
  const last = pageRows.at(-1);
  return {
    items,
    ...(hasMore && last !== undefined
      ? {
          nextCursor: {
            createdAt: last.created_at,
            runId: last.run_id
          }
        }
      : {})
  };
}

function checkpointCoversInboxOnlyAdvance(
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

async function loadCheckpointPayload(
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

async function loadTurnInputPayload(
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

function assertTurnInputIntroductionVersion(
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

async function loadEffectInputPayload(
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

async function loadEffectResultPayload(
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

function checkpointReference(
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

function effectPayloadReference(row: AgentEffectPayloadRow): AgentEffectPayloadReference {
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

function assertValidCommandCommit(commit: AgentRunCommandCommit): void {
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

function assertEventSequence(
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

function assertStableRunIdentity(current: AgentRun, next: AgentRun): void {
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

function parseRunRow(row: AgentRunRow, source: string): AgentRun {
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

function parseStoredRun(
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

function assertActiveRunMetadataConsistent(database: DatabaseSync): void {
  const row = database.prepare(
    `SELECT run_id
     FROM agent_v3_runs
     WHERE (
       state_status IN (
         'queued', 'running', 'waiting', 'recovering',
         'waiting_children', 'waiting_input', 'cancelling'
       )
       OR json_extract(aggregate_json, '$.state.status')
          IN (
            'queued', 'running', 'waiting', 'recovering',
            'waiting_children', 'waiting_input', 'cancelling'
          )
     )
       AND (
         state_status IS NOT json_extract(aggregate_json, '$.state.status')
         OR created_at IS NOT json_extract(aggregate_json, '$.createdAt')
         OR updated_at IS NOT json_extract(aggregate_json, '$.updatedAt')
       )
     LIMIT 1`
  ).get() as { run_id: string } | undefined;
  if (row !== undefined) {
    throw storageCorruption(`agent_v3_runs:${row.run_id}:recovery_metadata_mismatch`);
  }
}

function sameCommittedResult(
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

function assertRecoveryQueryRequest(request: AgentRunRecoveryQueryRequest): void {
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

function assertCheckpointReference(reference: AgentRunCheckpointReference): void {
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

function assertDirectivePayloadLookup(
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

async function verifyExactAdmittedRunForExecution(
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

function isCheckpointPayload(value: AgentJsonValue): value is AgentRunCheckpointPayload {
  return isRecord(value)
    && value.format === 'ariadne.agent-checkpoint'
    && value.schemaVersion === 1
    && Object.hasOwn(value, 'engineContinuation')
    && Object.hasOwn(value, 'modelContext');
}

function assertJsonValue(
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function isTimestamp(value: string): boolean {
  return value.length > 0 && Number.isFinite(Date.parse(value));
}

function serializeJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new AgentRunInvariantError('AgentRun persistence value is not JSON serializable.');
  }
  return serialized;
}

function isCommandDigest(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/u.test(value);
}

function parseJson(value: string, source: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw storageCorruption(`${source}:invalid_json`, error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function storageCorruption(message: string, cause?: unknown): Error {
  return new Error(`agent_v3_storage_corruption:${message}`, { cause });
}

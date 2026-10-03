import { DatabaseSync } from 'node:sqlite';
export { ConversationOutboxClaimError } from './ConversationHandoffStorageTypes.js';
export type { ConversationPersistenceClock, ConversationShutdownContext, ConversationPersistenceFaultInjector } from './ConversationHandoffStorageTypes.js';
import type { ConversationMessageReferenceV3 } from '@ariadne/protocol/public';
import { type ConversationMessageVersion, type ConversationSession } from '../../conversation/ConversationAuthority.js';
import { type ConversationRunHandoffSaga } from '../../conversation/ConversationRunHandoffSaga.js';
import type {
  CommittedConversationAuthorityCommand,
  ConversationAuthorityTransaction,
  ConversationAuthorityUnitOfWork
} from '../../control/ports/ConversationAuthorityPersistence.js';
import type { ConversationRunHandoffTransaction, ConversationRunHandoffUnitOfWork } from '../../control/ports/ConversationRunHandoffPersistence.js';
import type {
  ClaimedConversationOutboxMessage,
  ConversationOutboxClaimRequest,
  ConversationOutboxPublishRequest,
  ConversationRunHandoffOutboxPort
} from '../../control/ports/ConversationRunHandoffOutbox.js';
import type { ConversationRunHandoffLookup } from '../../control/ports/ConversationRunHandoffLookup.js';
import type {
  ConversationProjectionReadRequest,
  ConversationProjectionReader,
  ConversationProjectionRecord
} from '../../projection/ConversationProjectionPorts.js';
import { openConversationDatabase } from './ConversationDbSchema.js';
import { readConversationProjectionRecords } from './conversation/projection/SqliteConversationProjectionReader.js';
import {
  SqliteConversationNavigationStore,
  type ConversationSessionQueryItem,
  type ForkConversationSessionRequest,
  type ForkConversationSessionResult,
  type QueryConversationSessionsRequest,
  type ResolvedConversationMessageReference
} from './conversation/SqliteConversationNavigationStore.js';
import { closeOwnedSqliteDatabase } from './SqliteOwnerLease.js';
import { SqliteTransactionOwner } from './SqliteTransactionOwner.js';
import {
  type ConversationPersistenceClock,
  type ConversationPersistenceFaultInjector,
  type ConversationShutdownContext,
  type SagaRow
} from './ConversationHandoffStorageTypes.js';
import {
  acknowledgeOutbox,
  assertClaimRequest,
  assertPublishRequest,
  claimPendingOutbox
} from './ConversationHandoffOutbox.js';
import { SqliteConversationTransaction } from './SqliteConversationTransaction.js';
import {
  assertCanonicalId,
  canonicalNow,
  storageInvariant
} from './ConversationHandoffStorageValidation.js';
import { parseSagaRow, selectSagaRow } from './ConversationHandoffRowMapper.js';

export type {
  ClaimedConversationOutboxMessage,
  ConversationOutboxAcknowledgement,
  ConversationOutboxClaimRequest,
  ConversationOutboxPublishRequest
} from '../../control/ports/ConversationRunHandoffOutbox.js';

const SYSTEM_CLOCK: ConversationPersistenceClock = { now: () => new Date() };

/**
 * Sole SQLite write boundary for Conversation authority and Handoff. Each
 * callback owns one BEGIN IMMEDIATE transaction across every committed fact.
 */
export class SqliteConversationRunHandoffUnitOfWork
implements ConversationAuthorityUnitOfWork,
ConversationRunHandoffUnitOfWork,
ConversationRunHandoffOutboxPort,
ConversationRunHandoffLookup,
ConversationProjectionReader {
  private readonly database: DatabaseSync;
  private readonly navigation: SqliteConversationNavigationStore;
  private readonly transactionOwner: SqliteTransactionOwner;

  public constructor(
    dataRoot: string,
    private readonly clock: ConversationPersistenceClock = SYSTEM_CLOCK,
    private readonly faultInjector: ConversationPersistenceFaultInjector = {}
  ) {
    const opened = openConversationDatabase(dataRoot);
    try {
      recoverAbandonedConversationOutboxClaims(opened.database);
    } catch (error) {
      try {
        closeOwnedSqliteDatabase(opened.database, opened.ownerLease);
      } catch {
        // Preserve the takeover recovery error; uncertain close remains fenced.
      }
      throw error;
    }
    this.database = opened.database;
    this.navigation = new SqliteConversationNavigationStore(opened.database);
    this.transactionOwner = new SqliteTransactionOwner(
      opened.database,
      opened.databasePath,
      opened.ownerLease,
      {
        shutdownRequestedCode: 'conversation_unit_of_work_shutdown_requested',
        closedCode: 'conversation_unit_of_work_closed',
        shutdownConflictCode: 'conversation_shutdown_context_conflict',
        transactionActiveCode: 'conversation_transaction_already_active',
        shutdownDeadlineCode: 'conversation_shutdown_deadline_exceeded',
        beforeWriteCommit: () => this.faultInjector.beforeCommit?.(),
        afterWriteCommit: () => this.faultInjector.afterCommit?.()
      }
    );
  }

  public transaction<T>(
    operation: (transaction: ConversationRunHandoffTransaction) => Promise<T>
  ): Promise<T> {
    return this.scheduleOperation((signal) => this.executeDatabaseTransaction(
      'write',
      async () => {
        const transaction = new SqliteConversationTransaction(this.database);
        try {
          return await operation(transaction);
        } finally {
          transaction.close();
        }
      },
      signal
    ));
  }

  public authorityTransaction<T>(
    operation: (transaction: ConversationAuthorityTransaction) => Promise<T>
  ): Promise<T> {
    return this.scheduleOperation((signal) => this.executeDatabaseTransaction(
      'write',
      async () => {
        const transaction = new SqliteConversationTransaction(this.database);
        try {
          return await operation(transaction);
        } finally {
          transaction.close();
        }
      },
      signal
    ));
  }

  public claimPending(
    request: ConversationOutboxClaimRequest
  ): Promise<readonly ClaimedConversationOutboxMessage[]> {
    assertClaimRequest(request);
    return this.scheduleOperation((signal) => this.executeDatabaseTransaction(
      'write',
      () => claimPendingOutbox(this.database, request, canonicalNow(this.clock)),
      signal
    ));
  }

  public acknowledgePublished(request: ConversationOutboxPublishRequest): Promise<void> {
    assertPublishRequest(request);
    return this.scheduleOperation((signal) => this.executeDatabaseTransaction(
      'write',
      () => acknowledgeOutbox(this.database, request, canonicalNow(this.clock)),
      signal
    ));
  }

  public countPendingHandoffOutbox(): Promise<number> {
    return this.scheduleOperation((signal) => this.executeDatabaseTransaction(
      'read',
      () => {
        const row = this.database.prepare(
          `SELECT COUNT(*) AS count FROM conversation_handoff_outbox
           WHERE published_at IS NULL`
        ).get() as { count: number };
        const count = Number(row.count);
        if (!Number.isSafeInteger(count) || count < 0) {
          throw storageInvariant('outbox:pending_count_invalid');
        }
        return count;
      },
      signal
    ));
  }

  public readSaga(sagaId: string): Promise<ConversationRunHandoffSaga | null> {
    assertCanonicalId(sagaId, 'saga lookup');
    return this.scheduleOperation((signal) => this.executeDatabaseTransaction(
      'read',
      () => {
        const row = selectSagaRow(this.database, sagaId);
        return row === undefined ? null : parseSagaRow(row, `saga:${sagaId}`);
      },
      signal
    ));
  }

  public readMessageVersion(
    messageId: string,
    version: number
  ): Promise<ConversationMessageVersion | null> {
    assertCanonicalId(messageId, 'message version lookup');
    if (!Number.isSafeInteger(version) || version < 1) {
      throw storageInvariant('message_version_lookup_invalid');
    }
    return this.scheduleOperation((signal) => this.executeDatabaseTransaction(
      'read',
      () => this.navigation.readMessageVersion(messageId, version),
      signal
    ));
  }

  public readSagaByMessage(
    messageId: string,
    messageVersion: number
  ): Promise<ConversationRunHandoffSaga | null> {
    assertCanonicalId(messageId, 'saga message lookup');
    if (!Number.isSafeInteger(messageVersion) || messageVersion < 1) {
      throw new Error('conversation_saga_message_version_invalid');
    }
    return this.scheduleOperation((signal) => this.executeDatabaseTransaction(
      'read',
      () => {
        const row = this.database.prepare(
          `SELECT saga.saga_id, saga.version, saga.session_id, saga.workspace_id,
                  saga.message_id, saga.message_version, saga.objective_digest,
                  saga.stage_kind, saga.saga_json, saga.created_at, saga.updated_at,
                  message.content_digest AS authoritative_content_digest
           FROM conversation_handoff_sagas AS saga
           LEFT JOIN conversation_message_versions AS message
             ON message.message_id=saga.message_id
            AND message.version=saga.message_version
            AND message.session_id=saga.session_id
            AND message.workspace_id=saga.workspace_id
           WHERE saga.message_id=? AND saga.message_version=?`
        ).get(messageId, messageVersion) as SagaRow | undefined;
        return row === undefined
          ? null
          : parseSagaRow(
              row,
              `saga-message:${messageId}:${String(messageVersion)}`
            );
      },
      signal
    ));
  }

  public readSession(sessionId: string): Promise<ConversationSession | null> {
    assertCanonicalId(sessionId, 'session lookup');
    return this.scheduleOperation((signal) => this.executeDatabaseTransaction(
      'read',
      () => this.navigation.readSession(sessionId),
      signal
    ));
  }

  public forkSession(request: ForkConversationSessionRequest): Promise<ForkConversationSessionResult> {
    return this.scheduleOperation((signal) => this.executeDatabaseTransaction(
      'write',
      () => this.navigation.fork(request),
      signal
    ));
  }

  public querySessions(
    request: QueryConversationSessionsRequest
  ): Promise<readonly ConversationSessionQueryItem[]> {
    return this.scheduleOperation((signal) => this.executeDatabaseTransaction(
      'read',
      () => this.navigation.query(request),
      signal
    ));
  }

  public resolveMessageReference(
    reference: ConversationMessageReferenceV3
  ): Promise<ResolvedConversationMessageReference> {
    return this.scheduleOperation((signal) => this.executeDatabaseTransaction(
      'read',
      () => this.navigation.resolve(reference),
      signal
    ));
  }

  public readCommittedAuthorityCommand(
    commandId: string
  ): Promise<CommittedConversationAuthorityCommand | null> {
    assertCanonicalId(commandId, 'authority command lookup');
    return this.scheduleOperation((signal) => this.executeDatabaseTransaction(
      'read',
      async () => {
        const transaction = new SqliteConversationTransaction(this.database);
        try {
          return await transaction.loadCommittedAuthorityCommand(commandId);
        } finally {
          transaction.close();
        }
      },
      signal
    ));
  }

  public readProjectionRecords(
    request: ConversationProjectionReadRequest
  ): Promise<readonly ConversationProjectionRecord[]> {
    return this.scheduleOperation((signal) => this.executeDatabaseTransaction(
      'read',
      () => readConversationProjectionRecords(this.database, request),
      signal
    ));
  }

  public prepareShutdown(context: ConversationShutdownContext): void {
    this.transactionOwner.prepareShutdown(context);
  }

  public close(context: ConversationShutdownContext): Promise<void> {
    return this.transactionOwner.close(context);
  }

  private async executeDatabaseTransaction<T>(
    mode: 'read' | 'write',
    operation: () => T | Promise<T>,
    signal: AbortSignal
  ): Promise<T> {
    return this.transactionOwner.transaction(mode, operation, signal);
  }

  private scheduleOperation<T>(
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    return this.transactionOwner.schedule(operation);
  }
}
function recoverAbandonedConversationOutboxClaims(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(
      `UPDATE conversation_handoff_outbox
       SET claim_id=NULL, claimed_at=NULL, claim_expires_at=NULL
       WHERE published_at IS NULL AND claim_id IS NOT NULL;`
    );
    database.exec('COMMIT;');
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK;');
    throw new Error('conversation_outbox_owner_takeover_recovery_failed', {
      cause: error
    });
  }
}

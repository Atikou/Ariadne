import { DatabaseSync } from 'node:sqlite';
import type { ConversationMessageReferenceV3 } from '@ariadne/protocol/public';

import {
  ConversationAuthorityError,
  assertValidConversationAuthorityEvent,
  assertValidConversationAuthorityReceipt,
  assertValidConversationMessageHead,
  assertValidConversationMessageVersion,
  assertValidConversationSession,
  type ConversationAuthorityCommandReceipt,
  type ConversationAuthorityEvent,
  type ConversationMessageHead,
  type ConversationMessageVersion,
  type ConversationSession
} from '../../conversation/ConversationAuthority.js';
import {
  ConversationRunHandoffError,
  assertValidConversationRunHandoffSaga,
  projectConversationRunHandoffArtifacts,
  type ConversationRunHandoffEvent,
  type ConversationRunHandoffOutboxMessage,
  type ConversationRunHandoffSaga
} from '../../conversation/ConversationRunHandoffSaga.js';
import type {
  AcceptConversationUserMessageCommit,
  CommittedConversationAuthorityCommand,
  ConversationAuthorityTransaction,
  ConversationAuthorityUnitOfWork,
  CreateConversationSessionCommit,
  MutateConversationSessionCommit,
  ProjectConversationAgentStartFailureCommit,
  ProjectConversationAgentResultCommit
} from '../../control/ports/ConversationAuthorityPersistence.js';
import type {
  CommittedConversationRunHandoffCommand,
  ConversationRunHandoffCommit,
  ConversationRunHandoffTransaction,
  ConversationRunHandoffUnitOfWork
} from '../../control/ports/ConversationRunHandoffPersistence.js';
import type {
  ClaimedConversationOutboxMessage,
  ConversationOutboxClaimRequest,
  ConversationOutboxPublishRequest,
  ConversationRunHandoffOutboxPort
} from '../../control/ports/ConversationRunHandoffOutbox.js';
import type {
  ConversationRunHandoffLookup
} from '../../control/ports/ConversationRunHandoffLookup.js';
import type {
  ConversationProjectionReadRequest,
  ConversationProjectionReader,
  ConversationProjectionRecord
} from '../../projection/ConversationProjectionPorts.js';
import {
  openConversationDatabase
} from './ConversationDbSchema.js';
import {
  readConversationProjectionRecords
} from './conversation/projection/SqliteConversationProjectionReader.js';
import {
  insertConversationSessionVersion
} from './conversation/ConversationSessionVersionStore.js';
import {
  loadConversationHistoryThroughLineage,
  SqliteConversationNavigationStore,
  type ConversationSessionQueryItem,
  type ForkConversationSessionRequest,
  type ForkConversationSessionResult,
  type QueryConversationSessionsRequest,
  type ResolvedConversationMessageReference
} from './conversation/SqliteConversationNavigationStore.js';
import {
  assertMessageContentDigest,
  parseAuthorityCommandRow,
  parseMessageHeadRow,
  parseMessageVersionRow,
  parseSessionRow,
  type AuthorityCommandRow,
  type MessageHeadRow,
  type MessageVersionRow,
  type SessionRow
} from './conversation/rows/ConversationAuthorityRowMapper.js';
import {
  closeOwnedSqliteDatabase,
} from './SqliteOwnerLease.js';
import { SqliteTransactionOwner } from './SqliteTransactionOwner.js';

export interface ConversationPersistenceClock {
  now(): Date;
}

/** Structural match for the Runtime ShutdownContext without reversing layers. */
export interface ConversationShutdownContext {
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  remainingMs(reserveMs?: number): number;
  throwIfExpired(code?: string): void;
}

export interface ConversationPersistenceFaultInjector {
  beforeCommit?(): void;
  afterCommit?(): void;
}

export type {
  ClaimedConversationOutboxMessage,
  ConversationOutboxAcknowledgement,
  ConversationOutboxClaimRequest,
  ConversationOutboxPublishRequest
} from '../../control/ports/ConversationRunHandoffOutbox.js';

export class ConversationOutboxClaimError extends Error {
  public constructor(public readonly claimId: string, message: string) {
    super(message);
    this.name = 'ConversationOutboxClaimError';
  }
}

interface SagaRow {
  saga_id: string;
  version: number;
  session_id: string;
  workspace_id: string;
  message_id: string;
  message_version: number;
  objective_digest: string;
  stage_kind: string;
  saga_json: string;
  created_at: string;
  updated_at: string;
  authoritative_content_digest: string | null;
}

interface CommandRow {
  command_id: string;
  command_fingerprint: string;
  saga_id: string;
  resulting_version: number;
  result_saga_json: string;
}

interface EventRow {
  command_id: string;
  saga_id: string;
  saga_version: number;
  event_json: string;
  occurred_at: string;
}

interface OutboxRow {
  cursor: number;
  message_id: string;
  command_id: string;
  saga_id: string;
  saga_version: number;
  message_kind: string;
  message_json: string;
  created_at: string;
  published_at: string | null;
  published_claim_id: string | null;
  claim_id: string | null;
  claimed_at: string | null;
  claim_expires_at: string | null;
  claim_attempts: number;
  command_fingerprint: string | null;
  result_saga_json: string | null;
}

const SYSTEM_CLOCK: ConversationPersistenceClock = { now: () => new Date() };
const MAX_OUTBOX_LEASE_MS = 5 * 60 * 1000;

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

class SqliteConversationTransaction implements ConversationAuthorityTransaction {
  private active = true;
  private committed = false;

  public constructor(private readonly database: DatabaseSync) {}

  public async loadSession(sessionId: string): Promise<ConversationSession | null> {
    this.assertActive();
    assertCanonicalId(sessionId, 'session lookup');
    const row = this.database.prepare(
      `SELECT session_id, workspace_id, version, title, status, created_at, updated_at
       FROM conversation_sessions WHERE session_id=?`
    ).get(sessionId) as SessionRow | undefined;
    return row === undefined ? null : parseSessionRow(row, `session:${sessionId}`);
  }

  public async loadMessageHead(
    messageId: string
  ): Promise<ConversationMessageHead | null> {
    this.assertActive();
    assertCanonicalId(messageId, 'message head lookup');
    const row = this.database.prepare(
      `SELECT message_id, session_id, workspace_id, latest_version,
              created_at, updated_at
       FROM conversation_message_heads WHERE message_id=?`
    ).get(messageId) as MessageHeadRow | undefined;
    return row === undefined ? null : parseMessageHeadRow(row, `message-head:${messageId}`);
  }

  public async loadMessageVersion(
    messageId: string,
    version: number
  ): Promise<ConversationMessageVersion | null> {
    this.assertActive();
    assertCanonicalId(messageId, 'message version lookup');
    if (!Number.isSafeInteger(version) || version < 1) {
      throw storageInvariant('message_version_lookup_invalid');
    }
    const row = this.database.prepare(
      `SELECT message_id, version, session_id, workspace_id, role,
              payload_json, content_digest, created_at
       FROM conversation_message_versions WHERE message_id=? AND version=?`
    ).get(messageId, version) as MessageVersionRow | undefined;
    return row === undefined
      ? null
      : parseMessageVersionRow(row, `message-version:${messageId}:${String(version)}`);
  }

  public async loadSessionMessageHistoryThrough(
    sessionId: string,
    messageId: string,
    messageVersion: number
  ): Promise<readonly ConversationMessageVersion[]> {
    this.assertActive();
    assertCanonicalId(sessionId, 'session message history lookup');
    assertCanonicalId(messageId, 'session message history objective lookup');
    if (!Number.isSafeInteger(messageVersion) || messageVersion < 1) {
      throw storageInvariant('session_message_history_lookup_invalid');
    }
    return loadConversationHistoryThroughLineage(
      this.database,
      sessionId,
      messageId,
      messageVersion
    );
  }

  public async loadCommittedAuthorityCommand(
    commandId: string
  ): Promise<CommittedConversationAuthorityCommand | null> {
    this.assertActive();
    assertCanonicalId(commandId, 'authority command lookup');
    const row = this.database.prepare(
      `SELECT command.command_id, command.command_kind,
              command.command_fingerprint, command.event_id,
              command.session_id, command.workspace_id,
              command.expected_session_version,
              command.resulting_session_version,
              command.message_id, command.message_version, command.saga_id,
              command.saga_version, command.handoff_command_id,
              command.handoff_inbox_event_id,
              command.handoff_outbox_message_id, command.run_id,
              command.run_version, command.result_status,
              command.source_run_event_id,
              command.committed_at, event.event_id AS stored_event_id,
              event.session_id AS event_session_id,
              event.workspace_id AS event_workspace_id,
              event.session_version AS event_session_version,
              event.event_kind, event.event_json,
              event.occurred_at AS event_occurred_at
       FROM conversation_commands AS command
       LEFT JOIN conversation_events AS event ON event.command_id=command.command_id
       WHERE command.command_id=?`
    ).get(commandId) as AuthorityCommandRow | undefined;
    return row === undefined ? null : parseAuthorityCommandRow(row);
  }

  public async commitCreatedSession(
    commit: CreateConversationSessionCommit
  ): Promise<void> {
    this.beginCommit();
    assertValidConversationSession(commit.session);
    assertValidConversationAuthorityReceipt(commit.receipt);
    assertValidConversationAuthorityEvent(commit.event);
    if (
      commit.receipt.kind !== 'conversation.create_session'
      || commit.event.type !== 'conversation.session.created'
      || commit.session.version !== 1
      || commit.session.sessionId !== commit.receipt.sessionId
      || commit.session.workspaceId !== commit.receipt.workspaceId
      || commit.session.createdAt !== commit.receipt.committedAt
      || commit.session.updatedAt !== commit.receipt.committedAt
    ) throw authorityStorageCorruption('create_session_commit_binding_invalid');
    const existing = this.database.prepare(
      'SELECT version FROM conversation_sessions WHERE session_id=?'
    ).get(commit.session.sessionId) as { version: number } | undefined;
    if (existing !== undefined) {
      throw new ConversationAuthorityError(
        'CONVERSATION_SESSION_ALREADY_EXISTS',
        `Conversation session "${commit.session.sessionId}" already exists.`
      );
    }
    try {
      this.database.prepare(
        `INSERT INTO conversation_sessions(
           session_id, workspace_id, version, title, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        commit.session.sessionId,
        commit.session.workspaceId,
        commit.session.version,
        commit.session.title,
        commit.session.status,
        commit.session.createdAt,
        commit.session.updatedAt
      );
      insertConversationSessionVersion(this.database, commit.session);
      insertAuthorityReceiptAndEvent(
        this.database,
        commit.receipt,
        null,
        commit.event
      );
    } catch (error) {
      if (isConstraintError(error)) throw authorityCommandConflict(error);
      throw error;
    }
  }

  public async loadSessionVersion(
    sessionId: string,
    version: number
  ): Promise<ConversationSession | null> {
    this.assertActive();
    assertCanonicalId(sessionId, 'session version lookup');
    if (!Number.isSafeInteger(version) || version < 1) {
      throw storageInvariant('session_version_lookup_invalid');
    }
    const row = this.database.prepare(
      `SELECT session_id, workspace_id, version, title, status, created_at, updated_at
       FROM conversation_session_versions WHERE session_id=? AND version=?`
    ).get(sessionId, version) as SessionRow | undefined;
    return row === undefined
      ? null
      : parseSessionRow(row, `session-version:${sessionId}:${String(version)}`);
  }

  public async commitMutatedSession(
    commit: MutateConversationSessionCommit
  ): Promise<void> {
    this.beginCommit();
    assertValidConversationSession(commit.session);
    assertValidConversationAuthorityReceipt(commit.receipt);
    assertValidConversationAuthorityEvent(commit.event);
    if (
      commit.receipt.kind !== 'conversation.mutate_session'
      || commit.event.type !== 'conversation.session.updated'
      || commit.session.version !== commit.expectedSessionVersion + 1
      || commit.event.sessionVersion !== commit.session.version
      || commit.receipt.resultingSessionVersion !== commit.session.version
      || (
        commit.event.mutation.kind === 'rename'
          ? commit.session.title !== commit.event.mutation.title
          : commit.session.status !== commit.event.mutation.status
      )
    ) throw authorityStorageCorruption('mutate_session_commit_binding_invalid');
    const currentRow = this.database.prepare(
      `SELECT session_id, workspace_id, version, title, status, created_at, updated_at
       FROM conversation_sessions WHERE session_id=?`
    ).get(commit.session.sessionId) as SessionRow | undefined;
    if (currentRow === undefined) {
      throw new ConversationAuthorityError(
        'CONVERSATION_SESSION_NOT_FOUND',
        `Conversation session "${commit.session.sessionId}" does not exist.`
      );
    }
    const current = parseSessionRow(currentRow, `session:${commit.session.sessionId}:mutation-cas`);
    if (current.workspaceId !== commit.session.workspaceId) {
      throw new ConversationAuthorityError(
        'CONVERSATION_WORKSPACE_MISMATCH',
        'Conversation Session workspace differs at mutation commit.'
      );
    }
    if (current.version !== commit.expectedSessionVersion) {
      throw new ConversationAuthorityError(
        'CONVERSATION_SESSION_VERSION_CONFLICT',
        `Expected Conversation session version ${String(commit.expectedSessionVersion)}, found ${String(current.version)}.`
      );
    }
    try {
      const updated = this.database.prepare(
        `UPDATE conversation_sessions
         SET version=?, title=?, status=?, updated_at=?
         WHERE session_id=? AND workspace_id=? AND version=?`
      ).run(
        commit.session.version,
        commit.session.title,
        commit.session.status,
        commit.session.updatedAt,
        commit.session.sessionId,
        commit.session.workspaceId,
        commit.expectedSessionVersion
      );
      if (Number(updated.changes) !== 1) {
        throw new ConversationAuthorityError(
          'CONVERSATION_SESSION_VERSION_CONFLICT',
          'Conversation Session mutation CAS failed.'
        );
      }
      insertConversationSessionVersion(this.database, commit.session);
      insertAuthorityReceiptAndEvent(
        this.database,
        commit.receipt,
        commit.expectedSessionVersion,
        commit.event
      );
    } catch (error) {
      if (error instanceof ConversationAuthorityError) throw error;
      if (isConstraintError(error)) throw authorityCommandConflict(error);
      throw error;
    }
  }

  public async commitAcceptedUserMessage(
    commit: AcceptConversationUserMessageCommit
  ): Promise<void> {
    this.beginCommit();
    assertAcceptedMessageCommit(commit);
    const currentRow = this.database.prepare(
      `SELECT session_id, workspace_id, version, title, status, created_at, updated_at
       FROM conversation_sessions WHERE session_id=?`
    ).get(commit.session.sessionId) as SessionRow | undefined;
    if (currentRow === undefined) {
      throw new ConversationAuthorityError(
        'CONVERSATION_SESSION_NOT_FOUND',
        `Conversation session "${commit.session.sessionId}" does not exist.`
      );
    }
    const current = parseSessionRow(currentRow, `session:${commit.session.sessionId}:cas`);
    if (current.workspaceId !== commit.session.workspaceId) {
      throw new ConversationAuthorityError(
        'CONVERSATION_WORKSPACE_MISMATCH',
        'Conversation Session workspace differs at commit.'
      );
    }
    if (current.version !== commit.expectedSessionVersion) {
      throw new ConversationAuthorityError(
        'CONVERSATION_SESSION_VERSION_CONFLICT',
        `Expected Conversation session version ${String(commit.expectedSessionVersion)}, found ${String(current.version)}.`
      );
    }
    const existingHead = this.database.prepare(
      'SELECT message_id FROM conversation_message_heads WHERE message_id=?'
    ).get(commit.messageHead.messageId);
    if (existingHead !== undefined) {
      throw new ConversationAuthorityError(
        'CONVERSATION_MESSAGE_ALREADY_EXISTS',
        `Conversation message "${commit.messageHead.messageId}" already exists.`
      );
    }
    try {
      const updated = this.database.prepare(
        `UPDATE conversation_sessions
         SET version=?, updated_at=?
         WHERE session_id=? AND workspace_id=? AND version=?`
      ).run(
        commit.session.version,
        commit.session.updatedAt,
        commit.session.sessionId,
        commit.session.workspaceId,
        commit.expectedSessionVersion
      );
      if (Number(updated.changes) !== 1) {
        throw new ConversationAuthorityError(
          'CONVERSATION_SESSION_VERSION_CONFLICT',
          'Conversation Session CAS failed.'
        );
      }
      insertConversationSessionVersion(this.database, commit.session);
      this.database.prepare(
        `INSERT INTO conversation_message_heads(
           message_id, session_id, workspace_id, latest_version,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        commit.messageHead.messageId,
        commit.messageHead.sessionId,
        commit.messageHead.workspaceId,
        commit.messageHead.latestVersion,
        commit.messageHead.createdAt,
        commit.messageHead.updatedAt
      );
      this.database.prepare(
        `INSERT INTO conversation_message_versions(
           message_id, version, session_id, workspace_id, role,
           payload_json, content_digest, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        commit.messageVersion.messageId,
        commit.messageVersion.version,
        commit.messageVersion.sessionId,
        commit.messageVersion.workspaceId,
        commit.messageVersion.role,
        JSON.stringify(commit.messageVersion.payload),
        commit.messageVersion.contentDigest,
        commit.messageVersion.createdAt
      );
      insertAuthorityReceiptAndEvent(
        this.database,
        commit.receipt,
        commit.expectedSessionVersion,
        commit.event
      );
      // This transaction object shares the already-active BEGIN IMMEDIATE; its
      // commit method writes Handoff rows but never starts or commits SQLite.
      const handoffTransaction = new SqliteConversationTransaction(this.database);
      try {
        await handoffTransaction.commit(commit.handoff);
      } finally {
        handoffTransaction.close();
      }
    } catch (error) {
      if (error instanceof ConversationAuthorityError) throw error;
      if (error instanceof ConversationRunHandoffError) throw error;
      if (isConstraintError(error)) throw authorityCommandConflict(error);
      throw error;
    }
  }

  public async commitProjectedAgentResult(
    commit: ProjectConversationAgentResultCommit
  ): Promise<void> {
    return this.commitProjectedAssistantTerminal(commit);
  }

  public async commitProjectedAgentStartFailure(
    commit: ProjectConversationAgentStartFailureCommit
  ): Promise<void> {
    return this.commitProjectedAssistantTerminal(commit);
  }

  private async commitProjectedAssistantTerminal(
    commit: ProjectConversationAgentResultCommit | ProjectConversationAgentStartFailureCommit
  ): Promise<void> {
    this.beginCommit();
    assertProjectedAssistantTerminalCommit(commit);
    const currentRow = this.database.prepare(
      `SELECT session_id, workspace_id, version, title, status, created_at, updated_at
       FROM conversation_sessions WHERE session_id=?`
    ).get(commit.session.sessionId) as SessionRow | undefined;
    if (currentRow === undefined) {
      throw new ConversationAuthorityError(
        'CONVERSATION_SESSION_NOT_FOUND',
        `Conversation session "${commit.session.sessionId}" does not exist.`
      );
    }
    const current = parseSessionRow(
      currentRow,
      `session:${commit.session.sessionId}:agent-result-cas`
    );
    if (current.workspaceId !== commit.session.workspaceId) {
      throw new ConversationAuthorityError(
        'CONVERSATION_WORKSPACE_MISMATCH',
        'Conversation Session workspace differs at Agent result commit.'
      );
    }
    if (current.version !== commit.expectedSessionVersion) {
      throw new ConversationAuthorityError(
        'CONVERSATION_SESSION_VERSION_CONFLICT',
        `Expected Conversation session version ${String(commit.expectedSessionVersion)}, found ${String(current.version)}.`
      );
    }
    if (this.database.prepare(
      'SELECT message_id FROM conversation_message_heads WHERE message_id=?'
    ).get(commit.messageHead.messageId) !== undefined) {
      throw new ConversationAuthorityError(
        'CONVERSATION_MESSAGE_ALREADY_EXISTS',
        `Conversation message "${commit.messageHead.messageId}" already exists.`
      );
    }
    try {
      const updated = this.database.prepare(
        `UPDATE conversation_sessions
         SET version=?, updated_at=?
         WHERE session_id=? AND workspace_id=? AND version=?`
      ).run(
        commit.session.version,
        commit.session.updatedAt,
        commit.session.sessionId,
        commit.session.workspaceId,
        commit.expectedSessionVersion
      );
      if (Number(updated.changes) !== 1) {
        throw new ConversationAuthorityError(
          'CONVERSATION_SESSION_VERSION_CONFLICT',
          'Conversation Session Agent result CAS failed.'
        );
      }
      insertConversationSessionVersion(this.database, commit.session);
      this.database.prepare(
        `INSERT INTO conversation_message_heads(
           message_id, session_id, workspace_id, latest_version,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        commit.messageHead.messageId,
        commit.messageHead.sessionId,
        commit.messageHead.workspaceId,
        commit.messageHead.latestVersion,
        commit.messageHead.createdAt,
        commit.messageHead.updatedAt
      );
      this.database.prepare(
        `INSERT INTO conversation_message_versions(
           message_id, version, session_id, workspace_id, role,
           payload_json, content_digest, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        commit.messageVersion.messageId,
        commit.messageVersion.version,
        commit.messageVersion.sessionId,
        commit.messageVersion.workspaceId,
        commit.messageVersion.role,
        JSON.stringify(commit.messageVersion.payload),
        commit.messageVersion.contentDigest,
        commit.messageVersion.createdAt
      );
      const handoffTransaction = new SqliteConversationTransaction(this.database);
      try {
        await handoffTransaction.commit(commit.handoff);
      } finally {
        handoffTransaction.close();
      }
      insertAuthorityReceiptAndEvent(
        this.database,
        commit.receipt,
        commit.expectedSessionVersion,
        commit.event
      );
    } catch (error) {
      if (error instanceof ConversationAuthorityError) throw error;
      if (error instanceof ConversationRunHandoffError) throw error;
      if (isConstraintError(error)) throw authorityCommandConflict(error);
      throw error;
    }
  }

  public async loadSaga(sagaId: string): Promise<ConversationRunHandoffSaga | null> {
    this.assertActive();
    assertCanonicalId(sagaId, 'saga lookup');
    const row = selectSagaRow(this.database, sagaId);
    return row === undefined ? null : parseSagaRow(row, `saga:${sagaId}`);
  }

  public async loadCommittedCommand(
    commandId: string
  ): Promise<CommittedConversationRunHandoffCommand | null> {
    this.assertActive();
    assertCanonicalId(commandId, 'command lookup');
    const row = this.database.prepare(
      `SELECT command_id, command_fingerprint, saga_id,
              resulting_version, result_saga_json
       FROM conversation_handoff_commands WHERE command_id=?`
    ).get(commandId) as CommandRow | undefined;
    if (row === undefined) return null;
    return loadCommittedCommand(this.database, row);
  }

  public async commit(commit: ConversationRunHandoffCommit): Promise<void> {
    this.beginCommit();
    assertCommitArtifacts(commit);
    if (commit.expectedVersion === null) {
      assertAuthoritativeMessageForAcceptedHandoff(this.database, commit);
    }

    const currentRow = selectSagaRow(this.database, commit.sagaId);

    if (commit.expectedVersion === null) {
      if (currentRow !== undefined) {
        throw versionConflict(commit.sagaId, null, currentRow.version);
      }
      insertSaga(this.database, commit.saga);
    } else {
      if (currentRow === undefined) {
        throw versionConflict(commit.sagaId, commit.expectedVersion, null);
      }
      const current = parseSagaRow(currentRow, `saga:${commit.sagaId}:cas`);
      if (current.version !== commit.expectedVersion) {
        throw versionConflict(commit.sagaId, commit.expectedVersion, current.version);
      }
      assertImmutableIdentity(current, commit.saga);
      const result = this.database.prepare(
        `UPDATE conversation_handoff_sagas
         SET version=?, stage_kind=?, saga_json=?, updated_at=?
         WHERE saga_id=? AND version=?`
      ).run(
        commit.saga.version,
        commit.saga.stage.kind,
        JSON.stringify(commit.saga),
        commit.saga.updatedAt,
        commit.sagaId,
        commit.expectedVersion
      );
      if (Number(result.changes) !== 1) {
        throw versionConflict(commit.sagaId, commit.expectedVersion, null);
      }
    }

    const step = commit.saga.processedSteps[commit.saga.processedSteps.length - 1];
    if (step === undefined) throw storageInvariant('commit_step_missing');
    try {
      this.database.prepare(
        `INSERT INTO conversation_handoff_commands(
           command_id, command_fingerprint, saga_id, resulting_version,
           result_saga_json, committed_at
         ) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        commit.commandId,
        commit.commandFingerprint,
        commit.sagaId,
        commit.resultingVersion,
        JSON.stringify(commit.saga),
        commit.saga.updatedAt
      );
      this.database.prepare(
        `INSERT INTO conversation_handoff_inbox(
           inbox_event_id, command_id, saga_id, received_at
         ) VALUES (?, ?, ?, ?)`
      ).run(step.inboxEventId, commit.commandId, commit.sagaId, commit.saga.updatedAt);
      this.database.prepare(
        `INSERT INTO conversation_handoff_events(
           command_id, saga_id, saga_version, event_json, occurred_at
         ) VALUES (?, ?, ?, ?, ?)`
      ).run(
        commit.commandId,
        commit.sagaId,
        commit.resultingVersion,
        JSON.stringify(commit.event),
        commit.saga.updatedAt
      );
      this.database.prepare(
        `INSERT INTO conversation_handoff_outbox(
           message_id, command_id, saga_id, saga_version,
           message_kind, message_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        commit.outbox.messageId,
        commit.commandId,
        commit.sagaId,
        commit.resultingVersion,
        commit.outbox.kind,
        JSON.stringify(commit.outbox),
        commit.saga.updatedAt
      );
    } catch (error) {
      if (isConstraintError(error)) {
        throw new ConversationRunHandoffError(
          'HANDOFF_COMMAND_CONFLICT',
          'Command, inbox, event, or outbox identity is already bound.'
        );
      }
      throw error;
    }
  }

  public close(): void {
    this.active = false;
  }

  private assertActive(): void {
    if (!this.active) throw new Error('conversation_transaction_closed');
  }

  private beginCommit(): void {
    this.assertActive();
    if (this.committed) throw new Error('conversation_transaction_commit_already_called');
    this.committed = true;
  }
}

function assertAcceptedMessageCommit(commit: AcceptConversationUserMessageCommit): void {
  try {
    assertValidConversationSession(commit.session);
    assertValidConversationMessageHead(commit.messageHead);
    assertValidConversationMessageVersion(commit.messageVersion);
    assertMessageContentDigest(commit.messageVersion, 'accept-message-commit');
    assertValidConversationAuthorityReceipt(commit.receipt);
    assertValidConversationAuthorityEvent(commit.event);
    assertCommitArtifacts(commit.handoff);
  } catch (error) {
    if (
      error instanceof ConversationAuthorityError
      || error instanceof ConversationRunHandoffError
    ) throw error;
    throw authorityStorageCorruption('accept_message_commit_invalid', error);
  }
  const saga = commit.handoff.saga;
  const step = saga.processedSteps[0];
  if (
    !Number.isSafeInteger(commit.expectedSessionVersion)
    || commit.expectedSessionVersion < 1
    || commit.session.version !== commit.expectedSessionVersion + 1
    || commit.receipt.kind !== 'conversation.accept_user_message'
    || commit.event.type !== 'conversation.user_message.accepted'
    || commit.receipt.resultingSessionVersion !== commit.session.version
    || commit.receipt.eventId !== commit.event.eventId
    || commit.receipt.sessionId !== commit.session.sessionId
    || commit.receipt.workspaceId !== commit.session.workspaceId
    || commit.receipt.messageId !== commit.messageVersion.messageId
    || commit.receipt.messageVersion !== commit.messageVersion.version
    || commit.receipt.sagaId !== saga.sagaId
    || commit.receipt.committedAt !== commit.session.updatedAt
    || commit.messageHead.messageId !== commit.messageVersion.messageId
    || commit.messageHead.sessionId !== commit.messageVersion.sessionId
    || commit.messageHead.workspaceId !== commit.messageVersion.workspaceId
    || commit.messageHead.latestVersion !== commit.messageVersion.version
    || commit.messageHead.createdAt !== commit.messageVersion.createdAt
    || commit.messageHead.updatedAt !== commit.messageVersion.createdAt
    || commit.messageVersion.version !== 1
    || commit.event.sessionVersion !== commit.session.version
    || commit.event.messageId !== commit.messageVersion.messageId
    || commit.event.messageVersion !== commit.messageVersion.version
    || commit.event.contentDigest !== commit.messageVersion.contentDigest
    || saga.version !== 1
    || saga.stage.kind !== 'message_accepted'
    || saga.sessionId !== commit.messageVersion.sessionId
    || saga.workspaceId !== commit.messageVersion.workspaceId
    || saga.messageId !== commit.messageVersion.messageId
    || saga.messageVersion !== commit.messageVersion.version
    || saga.objectiveDigest !== commit.messageVersion.contentDigest
    || saga.createdAt !== commit.messageVersion.createdAt
    || step?.inboxEventId !== commit.event.eventId
  ) throw authorityStorageCorruption('accept_message_commit_binding_invalid');
}

function assertProjectedAssistantTerminalCommit(
  commit: ProjectConversationAgentResultCommit | ProjectConversationAgentStartFailureCommit
): void {
  if (commit.receipt.kind === 'conversation.project_agent_start_failure') {
    assertProjectedAgentStartFailureCommit(
      commit as ProjectConversationAgentStartFailureCommit
    );
    return;
  }
  assertProjectedAgentResultCommit(commit as ProjectConversationAgentResultCommit);
}

function assertProjectedAgentResultCommit(
  commit: ProjectConversationAgentResultCommit
): void {
  try {
    assertValidConversationSession(commit.session);
    assertValidConversationMessageHead(commit.messageHead);
    assertValidConversationMessageVersion(commit.messageVersion);
    assertMessageContentDigest(commit.messageVersion, 'project-agent-result-commit');
    assertValidConversationAuthorityReceipt(commit.receipt);
    assertValidConversationAuthorityEvent(commit.event);
    assertCommitArtifacts(commit.handoff);
  } catch (error) {
    if (
      error instanceof ConversationAuthorityError
      || error instanceof ConversationRunHandoffError
    ) throw error;
    throw authorityStorageCorruption('project_agent_result_commit_invalid', error);
  }
  const receipt = commit.receipt;
  const event = commit.event;
  const saga = commit.handoff.saga;
  const stage = saga.stage;
  const step = saga.processedSteps[saga.version - 1];
  if (
    !Number.isSafeInteger(commit.expectedSessionVersion)
    || commit.expectedSessionVersion < 1
    || commit.session.version !== commit.expectedSessionVersion + 1
    || receipt.kind !== 'conversation.project_agent_result'
    || event.type !== 'conversation.agent_result.projected'
    || commit.messageVersion.role !== 'assistant'
    || commit.messageVersion.version !== 1
    || commit.messageHead.messageId !== commit.messageVersion.messageId
    || commit.messageHead.sessionId !== commit.messageVersion.sessionId
    || commit.messageHead.workspaceId !== commit.messageVersion.workspaceId
    || commit.messageHead.latestVersion !== commit.messageVersion.version
    || commit.messageHead.createdAt !== commit.messageVersion.createdAt
    || commit.messageHead.updatedAt !== commit.messageVersion.createdAt
    || commit.session.sessionId !== commit.messageVersion.sessionId
    || commit.session.workspaceId !== commit.messageVersion.workspaceId
    || commit.session.updatedAt !== commit.messageVersion.createdAt
    || receipt.resultingSessionVersion !== commit.session.version
    || receipt.eventId !== event.eventId
    || receipt.sessionId !== commit.session.sessionId
    || receipt.workspaceId !== commit.session.workspaceId
    || receipt.messageId !== commit.messageVersion.messageId
    || receipt.messageVersion !== commit.messageVersion.version
    || receipt.committedAt !== commit.session.updatedAt
    || event.commandId !== receipt.commandId
    || event.sessionId !== receipt.sessionId
    || event.workspaceId !== receipt.workspaceId
    || event.sessionVersion !== receipt.resultingSessionVersion
    || event.messageId !== receipt.messageId
    || event.messageVersion !== receipt.messageVersion
    || event.contentDigest !== commit.messageVersion.contentDigest
    || event.sagaId !== receipt.sagaId
    || event.sagaVersion !== receipt.sagaVersion
    || event.runId !== receipt.runId
    || event.resultRunVersion !== receipt.resultRunVersion
    || event.resultStatus !== receipt.resultStatus
    || event.sourceRunEventId !== receipt.sourceRunEventId
    || event.occurredAt !== receipt.committedAt
    || commit.handoff.commandId !== receipt.handoffCommandId
    || commit.handoff.sagaId !== receipt.sagaId
    || commit.handoff.resultingVersion !== receipt.sagaVersion
    || commit.handoff.expectedVersion !== receipt.sagaVersion - 1
    || saga.version !== receipt.sagaVersion
    || saga.sessionId !== receipt.sessionId
    || saga.workspaceId !== receipt.workspaceId
    || stage.kind !== 'agent_result_projected'
    || stage.runId !== receipt.runId
    || stage.resultRunVersion !== receipt.resultRunVersion
    || stage.resultStatus !== receipt.resultStatus
    || stage.sourceRunEventId !== receipt.sourceRunEventId
    || step === undefined
    || step.commandId !== receipt.handoffCommandId
    || step.inboxEventId !== receipt.handoffInboxEventId
    || step.outboxMessageId !== receipt.handoffOutboxMessageId
  ) throw authorityStorageCorruption('project_agent_result_commit_binding_invalid');
}

function assertProjectedAgentStartFailureCommit(
  commit: ProjectConversationAgentStartFailureCommit
): void {
  try {
    assertValidConversationSession(commit.session);
    assertValidConversationMessageHead(commit.messageHead);
    assertValidConversationMessageVersion(commit.messageVersion);
    assertMessageContentDigest(commit.messageVersion, 'project-agent-start-failure-commit');
    assertValidConversationAuthorityReceipt(commit.receipt);
    assertValidConversationAuthorityEvent(commit.event);
    assertCommitArtifacts(commit.handoff);
  } catch (error) {
    if (error instanceof ConversationAuthorityError || error instanceof ConversationRunHandoffError) {
      throw error;
    }
    throw authorityStorageCorruption('project_agent_start_failure_commit_invalid', error);
  }
  const { receipt, event } = commit;
  const { saga } = commit.handoff;
  const stage = saga.stage;
  const step = saga.processedSteps[saga.version - 1];
  if (
    !Number.isSafeInteger(commit.expectedSessionVersion)
    || commit.expectedSessionVersion < 1
    || commit.session.version !== commit.expectedSessionVersion + 1
    || commit.messageVersion.role !== 'assistant'
    || commit.messageVersion.version !== 1
    || commit.messageHead.messageId !== commit.messageVersion.messageId
    || commit.messageHead.sessionId !== commit.messageVersion.sessionId
    || commit.messageHead.workspaceId !== commit.messageVersion.workspaceId
    || commit.session.sessionId !== commit.messageVersion.sessionId
    || commit.session.workspaceId !== commit.messageVersion.workspaceId
    || receipt.resultingSessionVersion !== commit.session.version
    || receipt.eventId !== event.eventId
    || receipt.messageId !== commit.messageVersion.messageId
    || receipt.messageVersion !== commit.messageVersion.version
    || event.type !== 'conversation.agent_start.failed'
    || event.sessionVersion !== receipt.resultingSessionVersion
    || event.messageId !== receipt.messageId
    || event.messageVersion !== receipt.messageVersion
    || event.contentDigest !== commit.messageVersion.contentDigest
    || event.sagaId !== receipt.sagaId
    || event.sagaVersion !== receipt.sagaVersion
    || event.runRequestId !== receipt.runRequestId
    || event.failureCode !== receipt.failureCode
    || commit.handoff.commandId !== receipt.handoffCommandId
    || commit.handoff.sagaId !== receipt.sagaId
    || saga.version !== receipt.sagaVersion
    || stage.kind !== 'agent_start_failed'
    || stage.runRequestId !== receipt.runRequestId
    || stage.failureCode !== receipt.failureCode
    || step?.commandId !== receipt.handoffCommandId
    || step.inboxEventId !== receipt.handoffInboxEventId
    || step.outboxMessageId !== receipt.handoffOutboxMessageId
  ) throw authorityStorageCorruption('project_agent_start_failure_commit_binding_invalid');
}

function insertAuthorityReceiptAndEvent(
  database: DatabaseSync,
  receipt: ConversationAuthorityCommandReceipt,
  expectedSessionVersion: number | null,
  event: ConversationAuthorityEvent
): void {
  assertValidConversationAuthorityReceipt(receipt);
  assertValidConversationAuthorityEvent(event);
  if (
    receipt.eventId !== event.eventId
    || receipt.commandId !== event.commandId
    || receipt.sessionId !== event.sessionId
    || receipt.workspaceId !== event.workspaceId
    || receipt.resultingSessionVersion !== event.sessionVersion
    || receipt.committedAt !== event.occurredAt
  ) throw authorityStorageCorruption('authority_receipt_event_binding_invalid');
  database.prepare(
    `INSERT INTO conversation_commands(
       command_id, command_kind, command_fingerprint, event_id,
       session_id, workspace_id, expected_session_version,
       resulting_session_version, message_id, message_version, saga_id,
       saga_version, handoff_command_id, handoff_inbox_event_id,
       handoff_outbox_message_id, run_id, run_version, result_status,
       source_run_event_id,
       committed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    receipt.commandId,
    receipt.kind,
    receipt.commandFingerprint,
    receipt.eventId,
    receipt.sessionId,
    receipt.workspaceId,
    expectedSessionVersion,
    receipt.resultingSessionVersion,
    receipt.messageId,
    receipt.messageVersion,
    receipt.sagaId,
    receipt.kind === 'conversation.project_agent_result'
      || receipt.kind === 'conversation.project_agent_start_failure'
      ? receipt.sagaVersion
      : null,
    receipt.kind === 'conversation.project_agent_result'
      || receipt.kind === 'conversation.project_agent_start_failure'
      ? receipt.handoffCommandId
      : null,
    receipt.kind === 'conversation.project_agent_result'
      || receipt.kind === 'conversation.project_agent_start_failure'
      ? receipt.handoffInboxEventId
      : null,
    receipt.kind === 'conversation.project_agent_result'
      || receipt.kind === 'conversation.project_agent_start_failure'
      ? receipt.handoffOutboxMessageId
      : null,
    receipt.kind === 'conversation.project_agent_result'
      ? receipt.runId
      : receipt.kind === 'conversation.project_agent_start_failure'
        ? receipt.runRequestId
      : null,
    receipt.kind === 'conversation.project_agent_result'
      ? receipt.resultRunVersion
      : null,
    receipt.kind === 'conversation.project_agent_result'
      ? receipt.resultStatus
      : null,
    receipt.kind === 'conversation.project_agent_result'
      ? receipt.sourceRunEventId
      : receipt.kind === 'conversation.project_agent_start_failure'
        ? receipt.failureCode
      : null,
    receipt.committedAt
  );
  database.prepare(
    `INSERT INTO conversation_events(
       event_id, command_id, session_id, workspace_id, session_version,
       event_kind, event_json, occurred_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    event.eventId,
    event.commandId,
    event.sessionId,
    event.workspaceId,
    event.sessionVersion,
    event.type,
    JSON.stringify(event),
    event.occurredAt
  );
}

function assertAuthoritativeMessageForAcceptedHandoff(
  database: DatabaseSync,
  commit: ConversationRunHandoffCommit
): void {
  const saga = commit.saga;
  const step = saga.processedSteps[0];
  if (saga.version !== 1 || saga.stage.kind !== 'message_accepted') {
    throw storageInvariant('handoff_initial_commit_stage_invalid');
  }
  const row = database.prepare(
    `SELECT message.message_id, message.version, message.session_id,
            message.workspace_id, message.role, message.payload_json,
            message.content_digest, message.created_at
     FROM conversation_message_versions AS message
     INNER JOIN conversation_commands AS command
       ON command.command_kind='conversation.accept_user_message'
      AND command.message_id=message.message_id
      AND command.message_version=message.version
      AND command.session_id=message.session_id
      AND command.workspace_id=message.workspace_id
      AND command.saga_id=?
      AND command.event_id=?
     WHERE message.message_id=? AND message.version=?`
  ).get(
    saga.sagaId,
    step?.inboxEventId ?? null,
    saga.messageId,
    saga.messageVersion
  ) as MessageVersionRow | undefined;
  if (row === undefined) {
    throw storageInvariant('handoff_accept_requires_authoritative_message_version');
  }
  const message = parseMessageVersionRow(
    row,
    `handoff:${saga.sagaId}:authoritative-message`
  );
  if (
    message.sessionId !== saga.sessionId
    || message.workspaceId !== saga.workspaceId
    || message.contentDigest !== saga.objectiveDigest
    || message.createdAt !== saga.createdAt
  ) throw storageInvariant('handoff_accept_authoritative_message_mismatch');
}

function insertSaga(database: DatabaseSync, saga: ConversationRunHandoffSaga): void {
  try {
    database.prepare(
      `INSERT INTO conversation_handoff_sagas(
         saga_id, version, session_id, workspace_id, message_id,
         message_version, objective_digest, stage_kind, saga_json,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      saga.sagaId,
      saga.version,
      saga.sessionId,
      saga.workspaceId,
      saga.messageId,
      saga.messageVersion,
      saga.objectiveDigest,
      saga.stage.kind,
      JSON.stringify(saga),
      saga.createdAt,
      saga.updatedAt
    );
  } catch (error) {
    if (isConstraintError(error)) {
      throw versionConflict(saga.sagaId, null, null);
    }
    throw error;
  }
}

function loadCommittedCommand(
  database: DatabaseSync,
  row: CommandRow
): CommittedConversationRunHandoffCommand {
  assertCanonicalId(row.command_id, 'stored command ID');
  assertDigest(row.command_fingerprint, 'stored command fingerprint');
  const saga = parseSagaJson(
    row.result_saga_json,
    `command:${row.command_id}:result_saga`
  );
  if (saga.sagaId !== row.saga_id || saga.version !== row.resulting_version) {
    throw storageInvariant(`command:${row.command_id}:saga_identity_mismatch`);
  }
  const eventRow = database.prepare(
    `SELECT command_id, saga_id, saga_version, event_json, occurred_at
     FROM conversation_handoff_events WHERE command_id=?`
  ).get(row.command_id) as EventRow | undefined;
  const outboxRow = database.prepare(
    `SELECT cursor, message_id, command_id, saga_id, saga_version,
            message_kind, message_json, created_at, published_at,
            published_claim_id, claim_id, claimed_at, claim_expires_at,
            claim_attempts
     FROM conversation_handoff_outbox WHERE command_id=?`
  ).get(row.command_id) as OutboxRow | undefined;
  if (eventRow === undefined || outboxRow === undefined) {
    throw storageInvariant(`command:${row.command_id}:artifacts_missing`);
  }
  const event = parseEvent(eventRow.event_json, `command:${row.command_id}:event`);
  const outbox = parseOutboxMessage(
    outboxRow.message_json,
    `command:${row.command_id}:outbox`
  );
  assertArtifactRows(row, saga, eventRow, event, outboxRow, outbox);
  assertExpectedArtifacts(saga, event, outbox);
  const step = saga.processedSteps[saga.version - 1];
  if (
    step === undefined
    || step.commandId !== row.command_id
    || step.fingerprint !== row.command_fingerprint
  ) {
    throw storageInvariant(`command:${row.command_id}:receipt_step_mismatch`);
  }
  return {
    commandId: row.command_id,
    commandFingerprint: row.command_fingerprint,
    sagaId: row.saga_id,
    resultingVersion: row.resulting_version,
    saga,
    event,
    outbox
  };
}

function selectSagaRow(database: DatabaseSync, sagaId: string): SagaRow | undefined {
  return database.prepare(
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
     WHERE saga.saga_id=?`
  ).get(sagaId) as SagaRow | undefined;
}

function parseSagaRow(row: SagaRow, source: string): ConversationRunHandoffSaga {
  const saga = parseSagaJson(row.saga_json, source);
  if (
    saga.sagaId !== row.saga_id
    || saga.version !== row.version
    || saga.sessionId !== row.session_id
    || saga.workspaceId !== row.workspace_id
    || saga.messageId !== row.message_id
    || saga.messageVersion !== row.message_version
    || saga.objectiveDigest !== row.objective_digest
    || saga.stage.kind !== row.stage_kind
    || saga.createdAt !== row.created_at
    || saga.updatedAt !== row.updated_at
    || row.authoritative_content_digest === null
    || saga.objectiveDigest !== row.authoritative_content_digest
  ) {
    throw storageInvariant(`${source}:column_identity_mismatch`);
  }
  return saga;
}

function parseSagaJson(value: string, source: string): ConversationRunHandoffSaga {
  const parsed = parseJson(value, source) as ConversationRunHandoffSaga;
  try {
    assertValidConversationRunHandoffSaga(parsed);
  } catch (error) {
    throw storageInvariant(`${source}:invalid_saga`, error);
  }
  return parsed;
}

function parseEvent(value: string, source: string): ConversationRunHandoffEvent {
  const parsed = parseJson(value, source);
  if (!isPlainObject(parsed) || typeof parsed.type !== 'string') {
    throw storageInvariant(`${source}:invalid_event`);
  }
  return parsed as unknown as ConversationRunHandoffEvent;
}

function parseOutboxMessage(
  value: string,
  source: string
): ConversationRunHandoffOutboxMessage {
  const parsed = parseJson(value, source);
  if (!isPlainObject(parsed) || typeof parsed.kind !== 'string') {
    throw storageInvariant(`${source}:invalid_message`);
  }
  return parsed as unknown as ConversationRunHandoffOutboxMessage;
}

function parseJson(value: string, source: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw storageInvariant(`${source}:invalid_json`, error);
  }
}

function assertCommitArtifacts(commit: ConversationRunHandoffCommit): void {
  assertCanonicalId(commit.commandId, 'commit.commandId');
  assertDigest(commit.commandFingerprint, 'commit.commandFingerprint');
  assertCanonicalId(commit.sagaId, 'commit.sagaId');
  try {
    assertValidConversationRunHandoffSaga(commit.saga);
  } catch (error) {
    if (error instanceof ConversationRunHandoffError) throw error;
    throw storageInvariant('commit_saga_invalid', error);
  }
  if (
    commit.saga.sagaId !== commit.sagaId
    || commit.saga.version !== commit.resultingVersion
    || commit.resultingVersion !== (commit.expectedVersion === null
      ? 1
      : commit.expectedVersion + 1)
  ) {
    throw storageInvariant('commit_version_identity_invalid');
  }
  const step = commit.saga.processedSteps[commit.saga.version - 1];
  if (
    step === undefined
    || step.commandId !== commit.commandId
    || step.fingerprint !== commit.commandFingerprint
    || step.outboxMessageId !== commit.outbox.messageId
  ) {
    throw storageInvariant('commit_step_identity_invalid');
  }
  assertExpectedArtifacts(commit.saga, commit.event, commit.outbox);
}

function assertExpectedArtifacts(
  saga: ConversationRunHandoffSaga,
  event: ConversationRunHandoffEvent,
  outbox: ConversationRunHandoffOutboxMessage
): void {
  const expected = projectConversationRunHandoffArtifacts(saga);
  if (
    canonicalize(event) !== canonicalize(expected.event)
    || canonicalize(outbox) !== canonicalize(expected.outbox)
  ) {
    throw storageInvariant(`saga:${saga.sagaId}:artifact_payload_mismatch`);
  }
}

function assertArtifactRows(
  command: CommandRow,
  saga: ConversationRunHandoffSaga,
  eventRow: EventRow,
  event: ConversationRunHandoffEvent,
  outboxRow: OutboxRow,
  outbox: ConversationRunHandoffOutboxMessage
): void {
  if (
    eventRow.command_id !== command.command_id
    || eventRow.saga_id !== saga.sagaId
    || eventRow.saga_version !== saga.version
    || eventRow.occurred_at !== saga.updatedAt
    || event.sagaVersion !== saga.version
    || outboxRow.command_id !== command.command_id
    || outboxRow.saga_id !== saga.sagaId
    || outboxRow.saga_version !== saga.version
    || outboxRow.message_id !== outbox.messageId
    || outboxRow.message_kind !== outbox.kind
    || outboxRow.created_at !== saga.updatedAt
    || outbox.sagaId !== saga.sagaId
    || outbox.sagaVersion !== saga.version
    || outbox.occurredAt !== saga.updatedAt
  ) {
    throw storageInvariant(`command:${command.command_id}:artifact_row_mismatch`);
  }
}

function assertImmutableIdentity(
  current: ConversationRunHandoffSaga,
  next: ConversationRunHandoffSaga
): void {
  if (
    current.sagaId !== next.sagaId
    || current.sessionId !== next.sessionId
    || current.workspaceId !== next.workspaceId
    || current.messageId !== next.messageId
    || current.messageVersion !== next.messageVersion
    || current.objectiveDigest !== next.objectiveDigest
    || current.createdAt !== next.createdAt
  ) {
    throw new ConversationRunHandoffError(
      'HANDOFF_COMMAND_CONFLICT',
      'Conversation handoff immutable identity changed during CAS.'
    );
  }
}

function claimPendingOutbox(
  database: DatabaseSync,
  request: ConversationOutboxClaimRequest,
  claimedAt: string
): readonly ClaimedConversationOutboxMessage[] {
  const existing = selectOutbox(database, 'published_at IS NULL AND claim_id=?', [
    request.claimId
  ]);
  if (existing.length > 0) {
    if (existing.some((row) => row.claim_expires_at === null || row.claim_expires_at <= claimedAt)) {
      throw new ConversationOutboxClaimError(
        request.claimId,
        `Conversation outbox claim "${request.claimId}" expired.`
      );
    }
    return existing.map(parseClaimedOutbox);
  }
  const completed = database.prepare(
    `SELECT COUNT(*) AS count FROM conversation_handoff_outbox
     WHERE published_claim_id=?`
  ).get(request.claimId) as { count: number };
  if (Number(completed.count) > 0) return [];

  const claimExpiresAt = new Date(Date.parse(claimedAt) + request.leaseMs).toISOString();
  const candidates = database.prepare(
    `SELECT cursor FROM conversation_handoff_outbox
     WHERE published_at IS NULL
       AND (claim_id IS NULL OR claim_expires_at <= ?)
     ORDER BY cursor LIMIT ?`
  ).all(claimedAt, request.limit) as unknown as Array<{ cursor: number }>;
  const update = database.prepare(
    `UPDATE conversation_handoff_outbox
     SET claim_id=?, claimed_at=?, claim_expires_at=?,
         claim_attempts=claim_attempts + 1
     WHERE cursor=? AND published_at IS NULL
       AND (claim_id IS NULL OR claim_expires_at <= ?)`
  );
  for (const candidate of candidates) {
    const result = update.run(
      request.claimId,
      claimedAt,
      claimExpiresAt,
      candidate.cursor,
      claimedAt
    );
    if (Number(result.changes) !== 1) {
      throw new ConversationOutboxClaimError(
        request.claimId,
        'Conversation outbox claim lost its candidate set.'
      );
    }
  }
  return selectOutbox(database, 'published_at IS NULL AND claim_id=?', [
    request.claimId
  ]).map(parseClaimedOutbox);
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

function acknowledgeOutbox(
  database: DatabaseSync,
  request: ConversationOutboxPublishRequest,
  publishedAt: string
): void {
  const rows: OutboxRow[] = [];
  for (const receipt of request.messages) {
    const row = database.prepare(
      `SELECT outbox.cursor, outbox.message_id, outbox.command_id,
              outbox.saga_id, outbox.saga_version, outbox.message_kind,
              outbox.message_json, outbox.created_at, outbox.published_at,
              outbox.published_claim_id, outbox.claim_id, outbox.claimed_at,
              outbox.claim_expires_at, outbox.claim_attempts,
              command.command_fingerprint, command.result_saga_json
       FROM conversation_handoff_outbox AS outbox
       LEFT JOIN conversation_handoff_commands AS command
         ON command.command_id=outbox.command_id
       WHERE outbox.cursor=?`
    ).get(receipt.cursor) as OutboxRow | undefined;
    if (row === undefined || row.message_id !== receipt.messageId) {
      throw new ConversationOutboxClaimError(
        request.claimId,
        'Conversation outbox ACK does not match its durable cursor and message.'
      );
    }
    parseAndValidateOutboxRow(row);
    if (row.published_at !== null) {
      if (row.published_claim_id !== request.claimId) {
        throw new ConversationOutboxClaimError(
          request.claimId,
          'Conversation outbox message was ACKed by a different claim.'
        );
      }
      rows.push(row);
      continue;
    }
    if (
      row.claim_id !== request.claimId
      || row.claim_expires_at === null
      || row.claim_expires_at <= publishedAt
    ) {
      throw new ConversationOutboxClaimError(
        request.claimId,
        'Conversation outbox ACK claim is missing, changed, or expired.'
      );
    }
    rows.push(row);
  }

  const update = database.prepare(
    `UPDATE conversation_handoff_outbox
     SET published_at=?, published_claim_id=?,
         claim_id=NULL, claimed_at=NULL, claim_expires_at=NULL
     WHERE cursor=? AND message_id=? AND published_at IS NULL AND claim_id=?`
  );
  for (const row of rows) {
    if (row.published_at !== null) continue;
    const result = update.run(
      publishedAt,
      request.claimId,
      row.cursor,
      row.message_id,
      request.claimId
    );
    if (Number(result.changes) !== 1) {
      throw new ConversationOutboxClaimError(
        request.claimId,
        'Conversation outbox ACK lost its exact durable claim.'
      );
    }
  }
}

function selectOutbox(
  database: DatabaseSync,
  where: string,
  parameters: readonly (string | number)[]
): OutboxRow[] {
  return database.prepare(
    `SELECT outbox.cursor, outbox.message_id, outbox.command_id,
            outbox.saga_id, outbox.saga_version, outbox.message_kind,
            outbox.message_json, outbox.created_at, outbox.published_at,
            outbox.published_claim_id, outbox.claim_id, outbox.claimed_at,
            outbox.claim_expires_at, outbox.claim_attempts,
            command.command_fingerprint, command.result_saga_json
     FROM conversation_handoff_outbox AS outbox
     LEFT JOIN conversation_handoff_commands AS command
       ON command.command_id=outbox.command_id
     WHERE ${where} ORDER BY outbox.cursor`
  ).all(...parameters) as unknown as OutboxRow[];
}

function parseClaimedOutbox(row: OutboxRow): ClaimedConversationOutboxMessage {
  if (row.claim_id === null || row.claimed_at === null || row.claim_expires_at === null) {
    throw storageInvariant(`outbox:${String(row.cursor)}:claim_metadata_missing`);
  }
  const message = parseAndValidateOutboxRow(row);
  return {
    cursor: row.cursor,
    claimId: row.claim_id,
    claimedAt: row.claimed_at,
    claimExpiresAt: row.claim_expires_at,
    claimAttempts: row.claim_attempts,
    message
  };
}

function parseAndValidateOutboxRow(row: OutboxRow): ConversationRunHandoffOutboxMessage {
  const message = parseOutboxMessage(row.message_json, `outbox:${String(row.cursor)}`);
  if (row.result_saga_json === null || row.command_fingerprint === null) {
    throw storageInvariant(`outbox:${String(row.cursor)}:command_receipt_missing`);
  }
  const saga = parseSagaJson(
    row.result_saga_json,
    `outbox:${String(row.cursor)}:result_saga`
  );
  const step = saga.processedSteps[saga.version - 1];
  if (
    !Number.isSafeInteger(row.cursor)
    || row.cursor <= 0
    || row.message_id !== message.messageId
    || row.saga_id !== message.sagaId
    || row.saga_version !== message.sagaVersion
    || row.message_kind !== message.kind
    || row.created_at !== message.occurredAt
    || saga.sagaId !== row.saga_id
    || saga.version !== row.saga_version
    || step === undefined
    || step.commandId !== row.command_id
    || step.fingerprint !== row.command_fingerprint
    || step.outboxMessageId !== row.message_id
    || !Number.isSafeInteger(row.claim_attempts)
    || row.claim_attempts < 0
  ) {
    throw storageInvariant(`outbox:${String(row.cursor)}:row_identity_mismatch`);
  }
  assertExpectedArtifacts(
    saga,
    projectConversationRunHandoffArtifacts(saga).event,
    message
  );
  assertCanonicalId(row.command_id, `outbox:${String(row.cursor)}:command_id`);
  assertOptionalOutboxMetadata(row);
  return message;
}

function assertOptionalOutboxMetadata(row: OutboxRow): void {
  if (row.published_at !== null) assertCanonicalUtcTimestamp(
    row.published_at,
    `outbox:${String(row.cursor)}:published_at`
  );
  if (row.published_claim_id !== null) {
    assertCanonicalId(
      row.published_claim_id,
      `outbox:${String(row.cursor)}:published_claim_id`
    );
  }
  if (row.claim_id === null && row.claimed_at === null && row.claim_expires_at === null) return;
  if (row.claim_id === null || row.claimed_at === null || row.claim_expires_at === null) {
    throw storageInvariant(`outbox:${String(row.cursor)}:partial_claim_metadata`);
  }
  assertCanonicalId(row.claim_id, `outbox:${String(row.cursor)}:claim_id`);
  assertCanonicalUtcTimestamp(row.claimed_at, `outbox:${String(row.cursor)}:claimed_at`);
  assertCanonicalUtcTimestamp(
    row.claim_expires_at,
    `outbox:${String(row.cursor)}:claim_expires_at`
  );
  if (Date.parse(row.claim_expires_at) <= Date.parse(row.claimed_at)) {
    throw storageInvariant(`outbox:${String(row.cursor)}:claim_time_invalid`);
  }
}

function assertClaimRequest(request: ConversationOutboxClaimRequest): void {
  assertCanonicalId(request.claimId, 'outbox claim ID');
  if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) {
    throw new Error('conversation_outbox_claim_limit_invalid');
  }
  if (
    !Number.isSafeInteger(request.leaseMs)
    || request.leaseMs < 1
    || request.leaseMs > MAX_OUTBOX_LEASE_MS
  ) {
    throw new Error('conversation_outbox_claim_lease_invalid');
  }
}

function assertPublishRequest(request: ConversationOutboxPublishRequest): void {
  assertCanonicalId(request.claimId, 'outbox ACK claim ID');
  if (!Array.isArray(request.messages)) {
    throw new Error('conversation_outbox_ack_messages_invalid');
  }
  const cursors = new Set<number>();
  const messageIds = new Set<string>();
  for (const message of request.messages) {
    if (!Number.isSafeInteger(message.cursor) || message.cursor <= 0) {
      throw new Error('conversation_outbox_ack_cursor_invalid');
    }
    assertCanonicalId(message.messageId, 'outbox ACK message ID');
    if (cursors.has(message.cursor) || messageIds.has(message.messageId)) {
      throw new Error('conversation_outbox_ack_duplicate');
    }
    cursors.add(message.cursor);
    messageIds.add(message.messageId);
  }
}

function canonicalNow(clock: ConversationPersistenceClock): string {
  const value = clock.now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('conversation_clock_invalid');
  }
  return value.toISOString();
}

function versionConflict(
  sagaId: string,
  expected: number | null,
  actual: number | null
): ConversationRunHandoffError {
  return new ConversationRunHandoffError(
    'HANDOFF_VERSION_CONFLICT',
    `Conversation saga "${sagaId}" CAS failed; expected ${String(expected)}, found ${String(actual)}.`
  );
}

function assertCanonicalId(value: string, field: string): void {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 256
    || value.trim() !== value
  ) {
    throw storageInvariant(`${field}:invalid`);
  }
}

function assertDigest(value: string, field: string): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw storageInvariant(`${field}:invalid`);
  }
}

function assertCanonicalUtcTimestamp(value: string, field: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw storageInvariant(`${field}:invalid`);
  }
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (!isPlainObject(value)) return 'invalid';
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalize(value[key])}`
  )).join(',')}}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error
    && (error.message.includes('constraint failed') || error.message.includes('UNIQUE constraint'));
}

function authorityCommandConflict(cause: unknown): ConversationAuthorityError {
  return new ConversationAuthorityError(
    'CONVERSATION_COMMAND_CONFLICT',
    'Conversation command, event, message, or Saga identity is already bound.',
    { cause }
  );
}

function authorityStorageCorruption(
  message: string,
  cause?: unknown
): ConversationAuthorityError {
  return new ConversationAuthorityError(
    'CONVERSATION_STORAGE_CORRUPTION',
    `Conversation storage corruption: ${message}.`,
    cause === undefined ? undefined : { cause }
  );
}

function storageInvariant(message: string, cause?: unknown): Error {
  return new Error(`conversation_storage_corruption:${message}`, { cause });
}

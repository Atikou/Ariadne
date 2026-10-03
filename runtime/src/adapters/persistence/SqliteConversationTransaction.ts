import { DatabaseSync } from 'node:sqlite';
import {
  ConversationAuthorityError,
  assertValidConversationAuthorityEvent,
  assertValidConversationAuthorityReceipt,
  assertValidConversationSession,
  type ConversationMessageHead,
  type ConversationMessageVersion,
  type ConversationSession
} from '../../conversation/ConversationAuthority.js';
import { ConversationRunHandoffError, type ConversationRunHandoffSaga } from '../../conversation/ConversationRunHandoffSaga.js';
import type {
  AcceptConversationUserMessageCommit,
  CommittedConversationAuthorityCommand,
  ConversationAuthorityTransaction,
  CreateConversationSessionCommit,
  MutateConversationSessionCommit,
  ProjectConversationAgentStartFailureCommit,
  ProjectConversationAgentResultCommit
} from '../../control/ports/ConversationAuthorityPersistence.js';
import type { CommittedConversationRunHandoffCommand, ConversationRunHandoffCommit } from '../../control/ports/ConversationRunHandoffPersistence.js';
import { insertConversationSessionVersion } from './conversation/ConversationSessionVersionStore.js';
import { loadConversationHistoryThroughLineage } from './conversation/SqliteConversationNavigationStore.js';
import {
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
  assertCanonicalId,
  authorityCommandConflict,
  authorityStorageCorruption,
  isConstraintError,
  storageInvariant,
  versionConflict
} from './ConversationHandoffStorageValidation.js';
import {
  assertAuthoritativeMessageForAcceptedHandoff,
  insertAuthorityReceiptAndEvent,
  insertSaga
} from './ConversationHandoffAuthorityWriter.js';
import {
  assertAcceptedMessageCommit,
  assertCommitArtifacts,
  assertImmutableIdentity,
  assertProjectedAssistantTerminalCommit
} from './ConversationHandoffCommitValidation.js';
import { parseSagaRow, selectSagaRow } from './ConversationHandoffRowMapper.js';
import { type CommandRow, type SagaRow } from './ConversationHandoffStorageTypes.js';
import { loadCommittedCommand } from './ConversationHandoffCommandReader.js';

export class SqliteConversationTransaction implements ConversationAuthorityTransaction {
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

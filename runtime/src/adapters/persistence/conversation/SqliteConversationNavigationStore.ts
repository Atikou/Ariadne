import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ConversationMessageReferenceV3 } from '@ariadne/protocol/public';

import type {
  ConversationMessageVersion,
  ConversationSession
} from '../../../conversation/ConversationAuthority.js';
import {
  parseMessageVersionRow,
  parseSessionRow,
  type MessageVersionRow,
  type SessionRow
} from './rows/ConversationAuthorityRowMapper.js';

export interface ConversationSessionLineage {
  readonly sourceSessionId: string;
  readonly sourceSessionVersion: number;
  readonly boundary: ConversationMessageReferenceV3;
  readonly createdAt: string;
}

export interface ForkConversationSessionRequest {
  readonly commandId: string;
  readonly eventId: string;
  readonly sessionId: string;
  readonly sourceSessionId: string;
  readonly workspaceId: string;
  readonly expectedSourceSessionVersion: number;
  readonly boundary: ConversationMessageReferenceV3;
  readonly occurredAt: string;
}

export interface ForkConversationSessionResult {
  readonly session: ConversationSession;
  readonly lineage: ConversationSessionLineage;
  readonly replayed: boolean;
}

export interface QueryConversationSessionsRequest {
  readonly workspaceId: string;
  readonly query: string;
  readonly status: 'active' | 'archived' | 'all';
  readonly limit: number;
}

export interface ConversationSessionQueryItem {
  readonly session: ConversationSession;
  readonly lineage: ConversationSessionLineage | null;
  readonly matches: readonly {
    readonly reference: ConversationMessageReferenceV3;
    readonly role: 'user' | 'assistant';
    readonly snippet: string;
  }[];
}

export interface ResolvedConversationMessageReference {
  readonly reference: ConversationMessageReferenceV3;
  readonly workspaceId: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly createdAt: string;
}

interface LineageRow {
  child_session_id: string;
  source_session_id: string;
  source_session_version: number;
  workspace_id: string;
  boundary_message_id: string;
  boundary_message_version: number;
  boundary_content_digest: string;
  created_at: string;
}

interface NavigationCommandRow {
  command_fingerprint: string;
  result_json: string;
}

/** Transaction-local owner for fork lineage, stable references, and read-only Session query. */
export class SqliteConversationNavigationStore {
  public constructor(private readonly database: DatabaseSync) {}

  public fork(request: ForkConversationSessionRequest): ForkConversationSessionResult {
    const fingerprint = digest(request);
    const replay = this.database.prepare(
      `SELECT command_fingerprint, result_json
       FROM conversation_navigation_commands WHERE command_id=?`
    ).get(request.commandId) as NavigationCommandRow | undefined;
    if (replay !== undefined) {
      if (replay.command_fingerprint !== fingerprint) {
        throw new Error('conversation_fork_command_conflict');
      }
      const parsed = JSON.parse(replay.result_json) as Omit<ForkConversationSessionResult, 'replayed'>;
      return { ...parsed, replayed: true };
    }
    const source = this.readSession(request.sourceSessionId);
    if (
      source === null
      || source.workspaceId !== request.workspaceId
      || source.version !== request.expectedSourceSessionVersion
      || request.boundary.sessionId !== source.sessionId
    ) throw new Error('conversation_fork_source_authority_changed');
    if (this.readSession(request.sessionId) !== null) {
      throw new Error('conversation_fork_session_already_exists');
    }
    const boundary = this.resolve(request.boundary);
    if (boundary.workspaceId !== request.workspaceId) {
      throw new Error('conversation_fork_boundary_workspace_mismatch');
    }
    const commandVersion = this.database.prepare(
      `SELECT resulting_session_version AS version
       FROM conversation_commands
       WHERE session_id=? AND message_id=? AND message_version=?`
    ).get(
      request.sourceSessionId,
      request.boundary.messageId,
      request.boundary.messageVersion
    ) as { version: number } | undefined;
    if (
      commandVersion === undefined
      || commandVersion.version > request.expectedSourceSessionVersion
    ) throw new Error('conversation_fork_boundary_not_settled');
    assertLineageDepth(this.database, request.sourceSessionId);

    const session: ConversationSession = {
      sessionId: request.sessionId,
      workspaceId: request.workspaceId,
      version: 1,
      title: forkTitle(source.title),
      status: 'active',
      createdAt: request.occurredAt,
      updatedAt: request.occurredAt
    };
    const lineage: ConversationSessionLineage = {
      sourceSessionId: source.sessionId,
      sourceSessionVersion: source.version,
      boundary: { ...request.boundary },
      createdAt: request.occurredAt
    };
    this.database.prepare(
      `INSERT INTO conversation_sessions(
         session_id, workspace_id, version, title, status, created_at, updated_at
       ) VALUES (?, ?, 1, ?, 'active', ?, ?)`
    ).run(session.sessionId, session.workspaceId, session.title, session.createdAt, session.updatedAt);
    this.database.prepare(
      `INSERT INTO conversation_session_versions(
         session_id, version, workspace_id, title, status, created_at, updated_at
       ) VALUES (?, 1, ?, ?, 'active', ?, ?)`
    ).run(session.sessionId, session.workspaceId, session.title, session.createdAt, session.updatedAt);
    this.database.prepare(
      `INSERT INTO conversation_session_lineage(
         child_session_id, source_session_id, source_session_version, workspace_id,
         boundary_message_id, boundary_message_version, boundary_content_digest, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      session.sessionId,
      source.sessionId,
      source.version,
      session.workspaceId,
      lineage.boundary.messageId,
      lineage.boundary.messageVersion,
      lineage.boundary.contentDigest,
      lineage.createdAt
    );
    const event = {
      eventId: request.eventId,
      type: 'conversation.session.created',
      commandId: request.commandId,
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
      sessionVersion: 1,
      occurredAt: request.occurredAt
    };
    this.database.prepare(
      `INSERT INTO conversation_commands(
         command_id, command_kind, command_fingerprint, event_id, session_id,
         workspace_id, expected_session_version, resulting_session_version,
         message_id, message_version, saga_id, saga_version, handoff_command_id,
         handoff_inbox_event_id, handoff_outbox_message_id, run_id, run_version,
         result_status, source_run_event_id, committed_at
       ) VALUES (?, 'conversation.create_session', ?, ?, ?, ?, NULL, 1,
                 NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)`
    ).run(
      request.commandId,
      fingerprint,
      request.eventId,
      session.sessionId,
      session.workspaceId,
      request.occurredAt
    );
    this.database.prepare(
      `INSERT INTO conversation_events(
         event_id, command_id, session_id, workspace_id, session_version,
         event_kind, event_json, occurred_at
       ) VALUES (?, ?, ?, ?, 1, 'conversation.session.created', ?, ?)`
    ).run(
      request.eventId,
      request.commandId,
      session.sessionId,
      session.workspaceId,
      JSON.stringify(event),
      request.occurredAt
    );
    const stored = { session, lineage };
    this.database.prepare(
      `INSERT INTO conversation_navigation_commands(
         command_id, command_fingerprint, child_session_id, result_json, committed_at
       ) VALUES (?, ?, ?, ?, ?)`
    ).run(
      request.commandId,
      fingerprint,
      session.sessionId,
      JSON.stringify(stored),
      request.occurredAt
    );
    return { ...stored, replayed: false };
  }

  public query(request: QueryConversationSessionsRequest): readonly ConversationSessionQueryItem[] {
    const needle = request.query.trim().toLowerCase();
    const pattern = `%${escapeLike(needle)}%`;
    const rows = this.database.prepare(
      `SELECT session_id, workspace_id, version, title, status, created_at, updated_at
       FROM conversation_sessions AS session
       WHERE workspace_id=?
         AND (?='all' OR status=?)
         AND (
           ?=''
           OR lower(title) LIKE ? ESCAPE '\\'
           OR EXISTS (
             SELECT 1 FROM conversation_message_versions AS message
             WHERE message.session_id=session.session_id
               AND lower(json_extract(message.payload_json, '$.content')) LIKE ? ESCAPE '\\'
           )
         )
       ORDER BY updated_at DESC, session_id ASC
       LIMIT ?`
    ).all(
      request.workspaceId,
      request.status,
      request.status,
      needle,
      pattern,
      pattern,
      request.limit
    ) as unknown as SessionRow[];
    return rows.map((row) => {
      const session = parseSessionRow(row, `session-query:${row.session_id}`);
      return {
        session,
        lineage: this.readLineage(session.sessionId),
        matches: needle.length === 0 ? [] : this.queryMatches(session.sessionId, pattern)
      };
    });
  }

  public resolve(reference: ConversationMessageReferenceV3): ResolvedConversationMessageReference {
    const row = this.database.prepare(
      `SELECT message_id, version, session_id, workspace_id, role,
              payload_json, content_digest, created_at
       FROM conversation_message_versions
       WHERE message_id=? AND version=? AND session_id=? AND content_digest=?`
    ).get(
      reference.messageId,
      reference.messageVersion,
      reference.sessionId,
      reference.contentDigest
    ) as MessageVersionRow | undefined;
    if (row === undefined) throw new Error('conversation_message_reference_not_found');
    const message = parseMessageVersionRow(row, `message-reference:${reference.messageId}`);
    return {
      reference: { ...reference },
      workspaceId: message.workspaceId,
      role: message.role,
      content: message.payload.content,
      createdAt: message.createdAt
    };
  }

  public readLineage(sessionId: string): ConversationSessionLineage | null {
    const row = this.database.prepare(
      `SELECT child_session_id, source_session_id, source_session_version, workspace_id,
              boundary_message_id, boundary_message_version, boundary_content_digest, created_at
       FROM conversation_session_lineage WHERE child_session_id=?`
    ).get(sessionId) as LineageRow | undefined;
    return row === undefined ? null : lineageFromRow(row);
  }

  public readSession(sessionId: string): ConversationSession | null {
    const row = this.database.prepare(
      `SELECT session_id, workspace_id, version, title, status, created_at, updated_at
       FROM conversation_sessions WHERE session_id=?`
    ).get(sessionId) as SessionRow | undefined;
    return row === undefined ? null : parseSessionRow(row, `navigation-session:${sessionId}`);
  }

  public readMessageVersion(
    messageId: string,
    version: number
  ): ConversationMessageVersion | null {
    const row = this.database.prepare(
      `SELECT message_id, version, session_id, workspace_id, role,
              payload_json, content_digest, created_at
       FROM conversation_message_versions WHERE message_id=? AND version=?`
    ).get(messageId, version) as MessageVersionRow | undefined;
    return row === undefined
      ? null
      : parseMessageVersionRow(row, `navigation-message:${messageId}:${String(version)}`);
  }

  private queryMatches(sessionId: string, pattern: string): ConversationSessionQueryItem['matches'] {
    const rows = this.database.prepare(
      `SELECT message_id, version, session_id, workspace_id, role,
              payload_json, content_digest, created_at
       FROM conversation_message_versions
       WHERE session_id=?
         AND lower(json_extract(payload_json, '$.content')) LIKE ? ESCAPE '\\'
       ORDER BY created_at DESC, message_id ASC, version DESC
       LIMIT 3`
    ).all(sessionId, pattern) as unknown as MessageVersionRow[];
    return rows.map((row) => {
      const message = parseMessageVersionRow(row, `session-query-match:${row.message_id}`);
      return {
        reference: {
          sessionId: message.sessionId,
          messageId: message.messageId,
          messageVersion: message.version,
          contentDigest: message.contentDigest
        },
        role: message.role,
        snippet: boundedSnippet(message.payload.content)
      };
    });
  }
}

export function loadConversationHistoryThroughLineage(
  database: DatabaseSync,
  sessionId: string,
  messageId: string,
  messageVersion: number,
  visited: ReadonlySet<string> = new Set()
): readonly ConversationMessageVersion[] {
  if (visited.has(sessionId) || visited.size >= 32) {
    throw new Error('conversation_lineage_cycle_or_depth_exceeded');
  }
  const nextVisited = new Set(visited).add(sessionId);
  const lineage = new SqliteConversationNavigationStore(database).readLineage(sessionId);
  const inherited = lineage === null
    ? []
    : loadConversationHistoryThroughLineage(
        database,
        lineage.sourceSessionId,
        lineage.boundary.messageId,
        lineage.boundary.messageVersion,
        nextVisited
      );
  const rows = database.prepare(
    `SELECT message.message_id, message.version, message.session_id,
            message.workspace_id, message.role, message.payload_json,
            message.content_digest, message.created_at
     FROM conversation_commands AS command
     INNER JOIN conversation_message_versions AS message
       ON message.message_id=command.message_id
      AND message.version=command.message_version
     WHERE command.session_id=?
       AND command.resulting_session_version <= (
         SELECT objective.resulting_session_version
         FROM conversation_commands AS objective
         WHERE objective.session_id=? AND objective.message_id=? AND objective.message_version=?
       )
     ORDER BY command.resulting_session_version ASC
     LIMIT 2048`
  ).all(sessionId, sessionId, messageId, messageVersion) as unknown as MessageVersionRow[];
  if (rows.length === 0) throw new Error('conversation_history_boundary_not_found');
  return [
    ...inherited,
    ...rows.map((row, index) => parseMessageVersionRow(
      row,
      `lineage-history:${sessionId}:${String(index)}`
    ))
  ];
}

function lineageFromRow(row: LineageRow): ConversationSessionLineage {
  return {
    sourceSessionId: row.source_session_id,
    sourceSessionVersion: Number(row.source_session_version),
    boundary: {
      sessionId: row.source_session_id,
      messageId: row.boundary_message_id,
      messageVersion: Number(row.boundary_message_version),
      contentDigest: row.boundary_content_digest
    },
    createdAt: row.created_at
  };
}

function assertLineageDepth(database: DatabaseSync, sessionId: string): void {
  let cursor: string | null = sessionId;
  const seen = new Set<string>();
  while (cursor !== null) {
    if (seen.has(cursor) || seen.size >= 32) throw new Error('conversation_lineage_cycle_or_depth_exceeded');
    seen.add(cursor);
    const row = database.prepare(
      'SELECT source_session_id FROM conversation_session_lineage WHERE child_session_id=?'
    ).get(cursor) as { source_session_id: string } | undefined;
    cursor = row?.source_session_id ?? null;
  }
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

function forkTitle(title: string): string {
  const suffix = ' (fork)';
  return title.length + suffix.length <= 80
    ? `${title}${suffix}`
    : `${title.slice(0, 80 - suffix.length)}${suffix}`;
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function boundedSnippet(content: string): string {
  const normalized = content.replace(/\s+/gu, ' ').trim();
  return normalized.length <= 512 ? normalized : `${normalized.slice(0, 509)}...`;
}

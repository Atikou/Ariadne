import { type DatabaseSync } from 'node:sqlite';

import {
  assertValidConversationSession,
  type ConversationSession
} from '../../../conversation/ConversationAuthority.js';

/** Appends one immutable Conversation session authority version. */
export function insertConversationSessionVersion(
  database: DatabaseSync,
  session: ConversationSession
): void {
  assertValidConversationSession(session);
  database.prepare(
    `INSERT INTO conversation_session_versions(
       session_id, version, workspace_id, title, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    session.sessionId,
    session.version,
    session.workspaceId,
    session.title,
    session.status,
    session.createdAt,
    session.updatedAt
  );
}

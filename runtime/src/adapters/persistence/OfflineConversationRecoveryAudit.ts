import type { DatabaseSync } from 'node:sqlite';
import { parseSessionRow, parseMessageHeadRow, parseMessageVersionRow, type SessionRow, type MessageHeadRow, type MessageVersionRow } from './conversation/rows/ConversationAuthorityRowMapper.js';
import { parseSagaRow } from './ConversationHandoffRowMapper.js';
import type { SagaRow } from './ConversationHandoffStorageTypes.js';
import { LocalConversationAttachmentStore } from '../attachment/LocalConversationAttachmentStore.js';

/** Original immutable message decoding verifies its content digest and image
 * references. Each original image reader then checks bytes, digest and format.
 * Only counts leave this sequential isolated audit. */
export async function auditOfflineConversationRecovery(database: DatabaseSync, dataRoot: string): Promise<number> {
  for (const table of ['conversation_sessions', 'conversation_session_versions'])
    for (const row of database.prepare('SELECT * FROM ' + table).iterate()) parseSessionRow(row as unknown as SessionRow, 'restore_session');
  for (const row of database.prepare('SELECT * FROM conversation_message_heads').iterate()) parseMessageHeadRow(row as unknown as MessageHeadRow, 'restore_head');
  const images = new LocalConversationAttachmentStore(dataRoot); let attachments = 0;
  for (const row of database.prepare('SELECT * FROM conversation_message_versions ORDER BY message_id,version').iterate()) {
    const message = parseMessageVersionRow(row as unknown as MessageVersionRow, 'restore_message');
    if (message.role === 'user') for (const ref of message.payload.attachments ?? []) { await images.readImage(ref); attachments++; }
  }
  for (const row of database.prepare(`SELECT saga.*, message.content_digest AS authoritative_content_digest
    FROM conversation_handoff_sagas AS saga LEFT JOIN conversation_message_versions AS message
    ON message.message_id=saga.message_id AND message.version=saga.message_version
    AND message.session_id=saga.session_id AND message.workspace_id=saga.workspace_id`).iterate())
    parseSagaRow(row as unknown as SagaRow, 'restore_saga');
  return attachments;
}

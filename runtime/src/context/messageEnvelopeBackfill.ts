import type { DatabaseSync } from "node:sqlite";

/** 为无 message_kind 的旧消息回填 envelope；除用户原文外一律 fail-closed。 */
export function backfillMessageEnvelopes(db: DatabaseSync): number {
  db.exec(`
    UPDATE messages
    SET message_kind = 'user_input', trusted = 1, source = 'user', ui_visible = 1
    WHERE role = 'user' AND (message_kind IS NULL OR message_kind = '');
  `);
  db.exec(`
    UPDATE messages
    SET message_kind = 'tool_result', trusted = 0, source = 'tool', ui_visible = 0
    WHERE role = 'tool' AND (message_kind IS NULL OR message_kind = '');
  `);
  db.exec(`
    UPDATE messages
    SET message_kind = 'workflow_event', trusted = 0, source = 'workflow', ui_visible = 0
    WHERE role = 'system' AND (message_kind IS NULL OR message_kind = '');
  `);
  db.exec(`
    UPDATE messages
    SET message_kind = 'tool_action', trusted = 0, source = 'model', ui_visible = 0
    WHERE role = 'assistant'
      AND (message_kind IS NULL OR message_kind = '')
      AND content LIKE '{"action":"tool"%';
  `);
  db.exec(`
    UPDATE messages
    SET message_kind = 'raw_model_final', trusted = 0, source = 'model', ui_visible = 0
    WHERE role = 'assistant'
      AND (message_kind IS NULL OR message_kind = '')
      AND content LIKE '{"action":"final"%';
  `);
  db.exec(`
    UPDATE messages
    SET message_kind = 'final_answer', trusted = 0, source = 'model', ui_visible = 0
    WHERE role = 'assistant' AND (message_kind IS NULL OR message_kind = '');
  `);

  return 0;
}

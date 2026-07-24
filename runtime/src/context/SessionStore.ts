import { randomUUID } from "node:crypto";

import type { DatabaseManager } from "./DatabaseManager.js";
import { mapSession, nowIso } from "./storeMappers.js";
import type { SessionRecord } from "./types.js";

export class SessionStore {
  constructor(private readonly db: DatabaseManager) {}

  create(title = "新会话", projectId?: string, workspaceKey?: string): SessionRecord {
    const id = randomUUID();
    const ts = nowIso();
    this.db.connection
      .prepare(
        `INSERT INTO sessions(id, title, status, project_id, workspace_key, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?, ?, ?)`,
      )
      .run(id, title, projectId ?? null, workspaceKey ?? null, ts, ts);
    return this.get(id)!;
  }

  get(id: string): SessionRecord | null {
    const row = this.db.connection
      .prepare(`SELECT * FROM sessions WHERE id=?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapSession(row) : null;
  }

  list(limit = 50): SessionRecord[] {
    const rows = this.db.connection
      .prepare(`SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map(mapSession);
  }

  touch(id: string, lastMessageId?: string): void {
    this.db.connection
      .prepare(`UPDATE sessions SET updated_at=?, last_message_id=COALESCE(?, last_message_id) WHERE id=?`)
      .run(nowIso(), lastMessageId ?? null, id);
  }

  setActiveTask(sessionId: string, taskId: string | null): void {
    this.db.connection
      .prepare(`UPDATE sessions SET active_task_id=?, updated_at=? WHERE id=?`)
      .run(taskId, nowIso(), sessionId);
  }

  updateTitle(id: string, title: string): SessionRecord | null {
    const trimmed = title.trim();
    if (!trimmed) return null;
    const result = this.db.connection
      .prepare(`UPDATE sessions SET title=?, updated_at=? WHERE id=?`)
      .run(trimmed, nowIso(), id);
    if (result.changes === 0) return null;
    return this.get(id);
  }

  delete(id: string): boolean {
    const result = this.db.connection.prepare(`DELETE FROM sessions WHERE id=?`).run(id);
    return result.changes > 0;
  }
}

import type { DatabaseSync } from "node:sqlite";

import {
  CompanionSessionSchema,
  type CompanionSession,
} from "./CompanionSessionContracts.js";

type CompanionSessionRow = {
  id: string;
  persona_id: string;
  title: string;
  storage_root: string;
  incognito: number;
  created_at: string;
  updated_at: string;
  last_summary_message_id: string | null;
};

/** Owns Companion session metadata while CompanionStorage owns the SQLite connection. */
export class CompanionSessionRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly storageRoot: string,
  ) {}

  create(input?: {
    id?: string;
    personaId?: string;
    title?: string;
    incognito?: boolean;
  }): CompanionSession {
    const id = input?.id ?? crypto.randomUUID();
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO companion_sessions
          (id, persona_id, title, storage_root, incognito, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input?.personaId ?? "default",
        input?.title ?? "助手会话",
        this.storageRoot,
        input?.incognito ? 1 : 0,
        at,
        at,
      );
    return this.get(id)!;
  }

  get(id: string): CompanionSession | null {
    const row = this.db
      .prepare("SELECT * FROM companion_sessions WHERE id=?")
      .get(id) as CompanionSessionRow | undefined;
    return row ? mapSession(row) : null;
  }

  list(limit = 50): CompanionSession[] {
    const rows = this.db
      .prepare("SELECT * FROM companion_sessions ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as CompanionSessionRow[];
    return rows.map(mapSession);
  }

  updateTitle(id: string, title: string): CompanionSession | null {
    const result = this.db
      .prepare("UPDATE companion_sessions SET title=?, updated_at=? WHERE id=?")
      .run(title, nowIso(), id);
    return Number(result.changes) === 1 ? this.get(id) : null;
  }

  touch(sessionId: string, patch?: { title?: string; lastSummaryMessageId?: string }): void {
    const at = nowIso();
    if (patch?.title !== undefined) {
      this.db
        .prepare("UPDATE companion_sessions SET title=?, updated_at=? WHERE id=?")
        .run(patch.title, at, sessionId);
      return;
    }
    if (patch?.lastSummaryMessageId !== undefined) {
      this.db
        .prepare("UPDATE companion_sessions SET last_summary_message_id=?, updated_at=? WHERE id=?")
        .run(patch.lastSummaryMessageId, at, sessionId);
      return;
    }
    this.db.prepare("UPDATE companion_sessions SET updated_at=? WHERE id=?").run(at, sessionId);
  }
}

function mapSession(row: CompanionSessionRow): CompanionSession {
  return CompanionSessionSchema.parse({
    id: row.id,
    personaId: row.persona_id,
    title: row.title,
    storageRoot: row.storage_root,
    incognito: row.incognito === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSummaryMessageId: row.last_summary_message_id ?? undefined,
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

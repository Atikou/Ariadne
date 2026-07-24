import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  applySqliteMigrations,
  getSchemaInfo,
  hashRowId,
  type SchemaInfo,
} from "../storage/sqliteMigration.js";
import {
  MEMORY_DB_MIGRATIONS,
  MEMORY_DB_SCHEMA_VERSION,
} from "./memoryDbMigrations.js";

/**
 * SQLite 存储层（Node 内置 node:sqlite，含 FTS5）。
 * 数据目录：{dataDir}/agent_data/memory.db
 */
export class DatabaseManager {
  readonly dbPath: string;
  readonly filesDir: string;
  readonly schemaVersion: number;
  readonly schemaInfo: SchemaInfo;
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    const agentData = path.join(dataDir, "agent_data");
    mkdirSync(agentData, { recursive: true });
    mkdirSync(path.join(agentData, "files"), { recursive: true });
    mkdirSync(path.join(agentData, "lancedb"), { recursive: true });
    mkdirSync(path.join(agentData, "logs", "messages"), { recursive: true });

    this.dbPath = path.join(agentData, "memory.db");
    this.filesDir = path.join(agentData, "files");
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    const { version } = applySqliteMigrations(this.db, MEMORY_DB_MIGRATIONS);
    this.schemaVersion = version;
    this.schemaInfo = getSchemaInfo(this.db);
    if (version !== MEMORY_DB_SCHEMA_VERSION) {
      throw new Error(`memory.db schema 版本异常：期望 ${MEMORY_DB_SCHEMA_VERSION}，实际 ${version}`);
    }
  }

  get connection(): DatabaseSync {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  upsertFts(ftsName: string, sourceId: string, content: string): void {
    const rowid = hashRowId(sourceId);
    this.db.prepare(`DELETE FROM ${ftsName} WHERE rowid=?`).run(rowid);
    this.db.prepare(`INSERT INTO ${ftsName}(rowid, content) VALUES (?, ?)`).run(rowid, content);
  }

  deleteFts(ftsName: string, sourceId: string): void {
    this.db.prepare(`DELETE FROM ${ftsName} WHERE rowid=?`).run(hashRowId(sourceId));
  }

  searchFts(ftsName: string, query: string, limit = 10): Array<{ rowid: number; content: string }> {
    const safe = query.replace(/"/g, '""').trim();
    if (!safe) return [];
    try {
      return this.db
        .prepare(
          `SELECT rowid, content FROM ${ftsName} WHERE content MATCH ? LIMIT ?`,
        )
        .all(`"${safe}"* OR ${safe}`, limit) as Array<{ rowid: number; content: string }>;
    } catch {
      return [];
    }
  }
}

export { hashRowId } from "../storage/sqliteMigration.js";

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

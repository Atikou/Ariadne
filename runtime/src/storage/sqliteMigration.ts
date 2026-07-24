import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

export interface SqliteMigration {
  readonly version: number;
  readonly name: string;
  readonly up: (db: DatabaseSync) => void;
}

export interface AppliedMigration {
  version: number;
  name: string;
  appliedAt: string;
}

export interface SchemaInfo {
  userVersion: number;
  migrations: AppliedMigration[];
}

export interface SqliteMigrationResult {
  version: number;
  newlyApplied: string[];
  backupPath?: string;
}

/** 确保 schema_migrations 审计表存在。 */
export function ensureMigrationTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER NOT NULL PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

export function getUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

export function assertDatabaseVersionSupported(
  db: DatabaseSync,
  maximumSupportedVersion: number,
): void {
  const current = getUserVersion(db);
  if (current > maximumSupportedVersion) {
    throw new Error(
      `sqlite_schema_newer_than_runtime:${current}:${maximumSupportedVersion}`,
    );
  }
}

export function listAppliedMigrations(db: DatabaseSync): AppliedMigration[] {
  ensureMigrationTable(db);
  const rows = db
    .prepare(`SELECT version, name, applied_at FROM schema_migrations ORDER BY version`)
    .all() as Array<{ version: number; name: string; applied_at: string }>;
  return rows.map((r) => ({
    version: r.version,
    name: r.name,
    appliedAt: r.applied_at,
  }));
}

function recordMigration(db: DatabaseSync, version: number, name: string, appliedAt?: string): void {
  const at = appliedAt ?? new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`,
  ).run(version, name, at);
}

function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table) as { name: string } | undefined;
  return row !== undefined;
}

/**
 * 旧库兼容：已有业务表或 PRAGMA user_version>0，但尚无 schema_migrations 记录时，回填审计行而不重跑 DDL。
 */
function backfillLegacyMigrations(
  db: DatabaseSync,
  migrations: readonly SqliteMigration[],
  targetVersion: number,
): void {
  ensureMigrationTable(db);
  const existing = listAppliedMigrations(db);
  if (existing.length > 0) return;

  const uv = getUserVersion(db);
  const legacy = uv > 0 || tableExists(db, "sessions") || tableExists(db, "tool_logs");
  if (!legacy) return;

  const now = new Date().toISOString();
  const backfillTo = uv > 0 ? Math.min(uv, targetVersion) : 0;
  const shouldRepairLegacyBootstrap =
    tableExists(db, "sessions") &&
    !tableExists(db, "messages") &&
    migrations.some((m) => m.name === "core_sessions_messages_memories");
  for (const m of migrations) {
    if (m.version <= backfillTo) {
      if (shouldRepairLegacyBootstrap && m.version <= Math.min(backfillTo, 7)) {
        m.up(db);
      }
      recordMigration(db, m.version, m.name, now);
    }
  }
  if (getUserVersion(db) < backfillTo) {
    db.exec(`PRAGMA user_version = ${backfillTo}`);
  }
}

/**
 * 按 version 递增应用迁移；每步写入 schema_migrations 并更新 PRAGMA user_version。
 */
export function applySqliteMigrations(
  db: DatabaseSync,
  migrations: readonly SqliteMigration[],
): SqliteMigrationResult {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const targetVersion = sorted[sorted.length - 1]?.version ?? 0;
  assertDatabaseVersionSupported(db, targetVersion);
  const initialVersion = getUserVersion(db);
  const backupPath = initialVersion < targetVersion
    ? createPreMigrationBackup(db, initialVersion, targetVersion)
    : undefined;

  let current = initialVersion;
  const newlyApplied: string[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    ensureMigrationTable(db);
    backfillLegacyMigrations(db, sorted, targetVersion);
    current = getUserVersion(db);

    for (const m of sorted) {
      if (m.version <= current) continue;
      if (m.version !== current + 1) {
        throw new Error(
          `SQLite 迁移版本断层：当前 ${current}，下一个是 ${m.version}（${m.name}）`,
        );
      }
      m.up(db);
      recordMigration(db, m.version, m.name);
      db.exec(`PRAGMA user_version = ${m.version}`);
      current = m.version;
      newlyApplied.push(m.name);
    }
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }

  return {
    version: current,
    newlyApplied,
    ...(backupPath ? { backupPath } : {}),
  };
}

export function getSchemaInfo(db: DatabaseSync): SchemaInfo {
  return {
    userVersion: getUserVersion(db),
    migrations: listAppliedMigrations(db),
  };
}

/** 迁移辅助：缺列时 ALTER TABLE ADD COLUMN。 */
export function addColumnIfMissing(
  db: DatabaseSync,
  table: string,
  column: string,
  ddl: string,
): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!rows.some((r) => r.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

/** 将 UUID 映射为稳定正整数 rowid（FTS5 要求整数 rowid）。 */
export function hashRowId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return (h % 2_000_000_000) + 1;
}

function createPreMigrationBackup(
  db: DatabaseSync,
  currentVersion: number,
  targetVersion: number,
): string | undefined {
  if (currentVersion === 0) {
    const userTable = db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type='table' AND name NOT LIKE 'sqlite_%'
       LIMIT 1`,
    ).get();
    if (!userTable) return undefined;
  }
  const database = db.prepare("PRAGMA database_list").all()
    .find((row) => (row as { name?: string }).name === "main") as
      | { file?: string }
      | undefined;
  const databasePath = database?.file;
  if (!databasePath || databasePath === ":memory:") return undefined;
  const backupRoot = path.join(path.dirname(databasePath), "migration-backups");
  mkdirSync(backupRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const backupPath = path.join(
    backupRoot,
    `${path.basename(databasePath)}.v${currentVersion}-to-v${targetVersion}.${stamp}.sqlite`,
  );
  db.exec(`VACUUM INTO '${backupPath.replace(/'/gu, "''")}'`);
  writeFileSync(`${backupPath}.json`, JSON.stringify({
    source: path.basename(databasePath),
    fromVersion: currentVersion,
    toVersion: targetVersion,
    createdAt: new Date().toISOString(),
    recovery: "replace_database_while_application_stopped",
  }, null, 2), "utf8");
  return backupPath;
}

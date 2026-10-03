import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { DatabaseManager } from "../src/context/DatabaseManager.js";
import {
  MEMORY_CONTROL_SHADOW_OFFLINE_MIGRATION_REQUIRED,
  MEMORY_CONTROL_SHADOW_TABLES,
  preflightMemoryControlShadows,
  preflightMemoryControlShadowsAtDatabasePath,
} from "../src/adapters/persistence/memoryControlShadowRetirement.js";
import {
  MEMORY_DB_MIGRATIONS,
  MEMORY_DB_SCHEMA_VERSION,
} from "../src/context/memoryDbMigrations.js";
import {
  applySqliteMigrations,
  getUserVersion,
  type SqliteMigration,
} from "../src/storage/sqliteMigration.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("memory.db control-shadow retirement", () => {
  it("does not create files or directories while preflighting an absent memory.db", () => {
    const root = createTemporaryRoot();
    const before = readdirSync(root);

    const result = preflightMemoryControlShadows(root);

    expect(result).toEqual({
      databasePath: path.join(root, "data", "agent_data", "memory.db"),
      presentTables: [],
    });
    expect(readdirSync(root)).toEqual(before);
    expect(existsSync(path.join(root, "data"))).toBe(false);
  });

  it("fresh installs finish at the current schema without active control-shadow tables", () => {
    const dataDir = path.join(createTemporaryRoot(), "data");
    const manager = new DatabaseManager(dataDir);
    try {
      expect(manager.schemaVersion).toBe(MEMORY_DB_SCHEMA_VERSION);
      expect(getUserVersion(manager.connection)).toBe(46);
      expect(controlShadowObjects(manager.connection)).toEqual([]);
      expect(manager.connection.prepare(
        "SELECT name FROM schema_migrations WHERE version=45",
      ).get()).toEqual({ name: "retire_isolated_control_store_shadows" });
      expect(manager.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      manager.close();
    }
  });

  it("upgrades an empty v44 database transactionally and clears stale sequences", () => {
    const { dataDir, dbPath, database } = createV44Database();
    seedAllControlShadows(database);
    emptyAllControlShadows(database);
    expect(database.prepare(
      "SELECT seq FROM sqlite_sequence WHERE name='agent_v2_outbox'",
    ).get()).toEqual({ seq: 1 });
    database.close();

    const preflight = preflightMemoryControlShadowsAtDatabasePath(dbPath);
    expect(preflight.presentTables).toEqual([...MEMORY_CONTROL_SHADOW_TABLES].sort());

    const manager = new DatabaseManager(dataDir);
    try {
      expect(manager.schemaVersion).toBe(46);
      expect(controlShadowObjects(manager.connection)).toEqual([]);
      expect(manager.connection.prepare(
        "SELECT name FROM sqlite_sequence WHERE name LIKE 'agent_v2_%'",
      ).all()).toEqual([]);
      expect(manager.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      manager.close();
    }
  });

  it("blocks a populated v44 before DatabaseManager performs any filesystem or database mutation", () => {
    const { dataDir, dbPath, database } = createV44Database();
    database.prepare(
      `INSERT INTO runtime_commands (
         command_id, command_digest, status, created_at, updated_at
       ) VALUES ('legacy-command', 'digest', 'executing', '2026-01-01', '2026-01-01')`,
    ).run();
    database.close();
    const bytesBefore = readFileSync(dbPath);
    const entriesBefore = readdirSync(path.dirname(dbPath)).sort();
    const snapshotBefore = databaseSnapshot(dbPath);

    expect(() => new DatabaseManager(dataDir)).toThrow(
      `${MEMORY_CONTROL_SHADOW_OFFLINE_MIGRATION_REQUIRED}:runtime_commands`,
    );

    expect(readFileSync(dbPath).equals(bytesBefore)).toBe(true);
    expect(readdirSync(path.dirname(dbPath)).sort()).toEqual(entriesBefore);
    expect(databaseSnapshot(dbPath)).toEqual(snapshotBefore);
  });

  it("rolls back schema, version, data and sqlite_sequence when v45 is interrupted, then succeeds on reopen", () => {
    const { dbPath, database } = createV44Database();
    seedAllControlShadows(database);
    emptyAllControlShadows(database);
    const before = databaseSnapshot(dbPath, database);
    const v45 = MEMORY_DB_MIGRATIONS.find((migration) => migration.version === 45)!;
    const interruptedV45: SqliteMigration = {
      ...v45,
      up(connection) {
        v45.up(connection);
        throw new Error("injected_v45_interruption");
      },
    };

    expect(() => applySqliteMigrations(database, [
      ...MEMORY_DB_MIGRATIONS.filter((migration) => migration.version < 45),
      interruptedV45,
    ])).toThrow("injected_v45_interruption");
    expect(databaseSnapshot(dbPath, database)).toEqual(before);
    database.close();

    const reopened = new DatabaseSync(dbPath);
    reopened.exec("PRAGMA foreign_keys = ON;");
    expect(applySqliteMigrations(reopened, MEMORY_DB_MIGRATIONS).version).toBe(46);
    expect(controlShadowObjects(reopened)).toEqual([]);
    expect(reopened.prepare(
      "SELECT name FROM sqlite_sequence WHERE name LIKE 'agent_v2_%'",
    ).all()).toEqual([]);
    expect(reopened.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    reopened.close();
  });

  it("fails closed on data in any legacy table without schema, audit, version or row mutation", () => {
    const { dbPath, database } = createV44Database();
    seedAllControlShadows(database);
    const before = databaseSnapshot(dbPath, database);

    expect(() => applySqliteMigrations(database, MEMORY_DB_MIGRATIONS)).toThrow(
      `${MEMORY_CONTROL_SHADOW_OFFLINE_MIGRATION_REQUIRED}:`
        + "agent_v2_checkpoints,agent_v2_commands,agent_v2_effect_payloads,"
        + "agent_v2_events,agent_v2_outbox,agent_v2_runs,runtime_commands",
    );

    expect(databaseSnapshot(dbPath, database)).toEqual(before);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  });
});

function createTemporaryRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "ariadne-memory-retirement-"));
  temporaryRoots.push(root);
  return root;
}

function createV44Database(): {
  readonly dataDir: string;
  readonly dbPath: string;
  readonly database: DatabaseSync;
} {
  const dataDir = path.join(createTemporaryRoot(), "data");
  const agentData = path.join(dataDir, "agent_data");
  mkdirSync(agentData, { recursive: true });
  const dbPath = path.join(agentData, "memory.db");
  const database = new DatabaseSync(dbPath);
  database.exec("PRAGMA foreign_keys = ON;");
  const result = applySqliteMigrations(
    database,
    MEMORY_DB_MIGRATIONS.filter((migration) => migration.version <= 44),
  );
  expect(result.version).toBe(44);
  return { dataDir, dbPath, database };
}

function seedAllControlShadows(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO agent_v2_runs (
      run_id, version, state_status, aggregate_json, created_at, updated_at
    ) VALUES ('legacy-run', 1, 'queued', '{}', '2026-01-01', '2026-01-01');
    INSERT INTO agent_v2_commands (
      command_id, command_digest, run_id, resulting_version,
      result_run_json, committed_at
    ) VALUES (
      'legacy-command', 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'legacy-run', 1, '{}', '2026-01-01'
    );
    INSERT INTO agent_v2_events (
      event_id, command_id, run_id, run_version, sequence, occurred_at, event_json
    ) VALUES (
      'legacy-event', 'legacy-command', 'legacy-run', 1, 1, '2026-01-01', '{}'
    );
    INSERT INTO agent_v2_outbox (
      event_id, aggregate_id, aggregate_version, event_json, created_at
    ) VALUES ('legacy-event', 'legacy-run', 1, '{}', '2026-01-01');
    INSERT INTO agent_v2_checkpoints (
      run_id, checkpoint_version, run_version, command_id,
      codec_id, payload_json, created_at
    ) VALUES ('legacy-run', 1, 1, 'legacy-command', 'json', '{}', '2026-01-01');
    INSERT INTO agent_v2_effect_payloads (
      run_id, effect_id, input_digest, input_command_id, input_run_version,
      input_codec_id, input_payload_json, created_at, updated_at
    ) VALUES (
      'legacy-run', 'legacy-effect', 'digest', 'legacy-command', 1,
      'json', '{}', '2026-01-01', '2026-01-01'
    );
    INSERT INTO runtime_commands (
      command_id, command_digest, status, created_at, updated_at
    ) VALUES ('legacy-runtime', 'digest', 'executing', '2026-01-01', '2026-01-01');
  `);
}

function emptyAllControlShadows(database: DatabaseSync): void {
  database.exec(`
    DELETE FROM agent_v2_outbox;
    DELETE FROM agent_v2_effect_payloads;
    DELETE FROM agent_v2_checkpoints;
    DELETE FROM agent_v2_events;
    DELETE FROM agent_v2_commands;
    DELETE FROM agent_v2_runs;
    DELETE FROM runtime_commands;
  `);
}

function controlShadowObjects(database: DatabaseSync): unknown[] {
  return database.prepare(
    `SELECT type, name FROM sqlite_master
     WHERE name IN (${MEMORY_CONTROL_SHADOW_TABLES.map(() => "?").join(", ")})
     ORDER BY type, name`,
  ).all(...MEMORY_CONTROL_SHADOW_TABLES);
}

function databaseSnapshot(dbPath: string, openDatabase?: DatabaseSync): unknown {
  const database = openDatabase ?? new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      userVersion: getUserVersion(database),
      journalMode: database.prepare("PRAGMA journal_mode").get(),
      migrations: database.prepare(
        "SELECT version, name, applied_at FROM schema_migrations ORDER BY version",
      ).all(),
      schema: database.prepare(
        `SELECT type, name, tbl_name, sql FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_autoindex_%'
         ORDER BY type, name`,
      ).all(),
      rows: Object.fromEntries(MEMORY_CONTROL_SHADOW_TABLES.map((table) => [
        table,
        database.prepare(`SELECT * FROM ${table}`).all(),
      ])),
      sequences: database.prepare(
        "SELECT name, seq FROM sqlite_sequence ORDER BY name",
      ).all(),
    };
  } finally {
    if (!openDatabase) database.close();
  }
}

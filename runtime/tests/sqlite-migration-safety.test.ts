import { access, mkdir,mkdtemp, readFile,readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";
import { TraceIndexStore } from "../src/trace/TraceIndexStore.js";
import { TRACE_INDEX_SCHEMA_VERSION } from "../src/trace/traceIndexMigrations.js";

import {
  applySqliteMigrations,
  assertDatabaseVersionSupported,
  getUserVersion,
  type SqliteMigration,
} from "../src/storage/sqliteMigration.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SQLite migration safety", () => {
  it("trace owner rejects future audit metadata before writable startup or directory changes",async()=>{
    const owners=[
      {name:'trace',schema:TRACE_INDEX_SCHEMA_VERSION,file:'index.db',create:(root:string)=>new TraceIndexStore(path.join(root,'index.db'))}
    ];
    for(const owner of owners){
      const root=await mkdtemp(path.join(os.tmpdir(),`ariadne-legacy-${owner.name}-`));roots.push(root);const dbPath=path.join(root,owner.file);await mkdir(path.dirname(dbPath),{recursive:true});
      const db=new DatabaseSync(dbPath);db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL);PRAGMA user_version=1;');
      db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(owner.schema+1,'future_migration','2026-10-04T00:00:00.000Z');db.close();
      const bytes=await readFile(dbPath);const directories=(await readdir(root,{recursive:true})).sort();
      for(let attempt=0;attempt<2;attempt++){
        expect(()=>owner.create(root)).toThrow(`sqlite_schema_newer_than_runtime:${owner.schema+1}:${owner.schema}`);
        expect(await readFile(dbPath)).toEqual(bytes);expect((await readdir(root,{recursive:true})).sort()).toEqual(directories);
      }
    }
  });
  it("rejects newer migration audit metadata even when user_version appears supported, without changing bytes", async () => {
    const dbPath=await databasePath();const fixture=new DatabaseSync(dbPath);
    fixture.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL); PRAGMA user_version=1;");
    fixture.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(99,"future_owner_migration","2026-10-04T00:00:00.000Z");fixture.close();
    const before=await readFile(dbPath);
    for(let attempt=0;attempt<2;attempt++) {
      const old=new DatabaseSync(dbPath);try{
        expect(()=>assertDatabaseVersionSupported(old,2)).toThrow("sqlite_schema_newer_than_runtime:99:2");
        expect(()=>applySqliteMigrations(old,[migration1,migration2])).toThrow("sqlite_schema_newer_than_runtime:99:2");
      }finally{old.close();}
      expect(await readFile(dbPath)).toEqual(before);
    }
  });
  it("rejects audit metadata ahead of the declared database version before applying DDL", async () => {
    const dbPath=await databasePath();const db=new DatabaseSync(dbPath);
    try {
      db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL); PRAGMA user_version=1;");
      db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(2,"already_recorded","2026-10-04T00:00:00.000Z");
      expect(()=>applySqliteMigrations(db,[migration1,migration2])).toThrow("sqlite_schema_audit_version_ahead:2:1");
      expect(getUserVersion(db)).toBe(1);expect(db.prepare("SELECT name FROM sqlite_master WHERE name='records'").get()).toBeUndefined();
    }finally{db.close();}
  });
  it("backs up N-1, migrates atomically and leaves a downgrade recovery manifest", async () => {
    const dbPath = await databasePath();
    const first = new DatabaseSync(dbPath);
    applySqliteMigrations(first, [migration1]);
    first.prepare("INSERT INTO records(value) VALUES (?)").run("preserved");
    first.close();

    const upgraded = new DatabaseSync(dbPath);
    const result = applySqliteMigrations(upgraded, [migration1, migration2]);
    expect(result.version).toBe(2);
    expect(result.backupPath).toBeTruthy();
    expect(upgraded.prepare("SELECT value FROM records").get()).toEqual({
      value: "preserved",
    });
    upgraded.close();

    await expect(access(result.backupPath!)).resolves.toBeUndefined();
    const manifest = JSON.parse(await readFile(`${result.backupPath}.json`, "utf8"));
    expect(manifest).toMatchObject({
      fromVersion: 1,
      toVersion: 2,
      recovery: "replace_database_while_application_stopped",
    });
    const backup = new DatabaseSync(result.backupPath!);
    expect(getUserVersion(backup)).toBe(1);
    expect(backup.prepare("SELECT value FROM records").get()).toEqual({
      value: "preserved",
    });
    backup.close();
  });

  it("rolls back DDL, audit rows and user_version when a migration fails", async () => {
    const dbPath = await databasePath();
    const db = new DatabaseSync(dbPath);
    applySqliteMigrations(db, [migration1]);
    const failing: SqliteMigration = {
      version: 2,
      name: "failing",
      up(connection) {
        connection.exec("CREATE TABLE must_rollback(id INTEGER);");
        throw new Error("injected_migration_failure");
      },
    };

    expect(() => applySqliteMigrations(db, [migration1, failing]))
      .toThrow("injected_migration_failure");
    expect(getUserVersion(db)).toBe(1);
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='must_rollback'",
    ).get()).toBeUndefined();
    expect(db.prepare(
      "SELECT version FROM schema_migrations ORDER BY version",
    ).all()).toEqual([{ version: 1 }]);
    db.close();
  });

  it("rejects a newer schema before creating compatibility tables or writing pragmas", async () => {
    const dbPath = await databasePath();
    const future = new DatabaseSync(dbPath);
    future.exec("PRAGMA user_version = 99");
    future.close();

    const oldRuntime = new DatabaseSync(dbPath);
    expect(() => assertDatabaseVersionSupported(oldRuntime, 41))
      .toThrow("sqlite_schema_newer_than_runtime:99:41");
    expect(() => applySqliteMigrations(oldRuntime, [migration1, migration2]))
      .toThrow("sqlite_schema_newer_than_runtime:99:2");
    expect(oldRuntime.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
    ).get()).toBeUndefined();
    expect(getUserVersion(oldRuntime)).toBe(99);
    oldRuntime.close();
  });
});

const migration1: SqliteMigration = {
  version: 1,
  name: "records",
  up(db) {
    db.exec("CREATE TABLE records(value TEXT NOT NULL);");
  },
};

const migration2: SqliteMigration = {
  version: 2,
  name: "records_index",
  up(db) {
    db.exec("CREATE INDEX idx_records_value ON records(value);");
  },
};

async function databasePath(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ariadne-migration-"));
  roots.push(root);
  return path.join(root, "fixture.db");
}

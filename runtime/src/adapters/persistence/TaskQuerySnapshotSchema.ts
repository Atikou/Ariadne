import type { DatabaseSync } from 'node:sqlite';

const schema: Readonly<Record<string, string>> = {
  task_query_snapshots: `CREATE TABLE task_query_snapshots (
    snapshot_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, filter_json TEXT NOT NULL,
    captured_at TEXT NOT NULL, expires_at INTEGER NOT NULL, coverage_json TEXT,
    ready INTEGER NOT NULL CHECK(ready IN (0,1))
  ) STRICT`,
  task_query_rows: `CREATE TABLE task_query_rows (
    snapshot_id TEXT NOT NULL REFERENCES task_query_snapshots(snapshot_id) ON DELETE CASCADE,
    task_key TEXT NOT NULL, sort_time TEXT NOT NULL, row_json TEXT NOT NULL,
    PRIMARY KEY(snapshot_id,task_key)
  ) STRICT`,
  task_query_page: 'CREATE INDEX task_query_page ON task_query_rows(snapshot_id,sort_time DESC,task_key)',
  task_query_current: `CREATE TABLE task_query_current (
    task_key TEXT PRIMARY KEY,source TEXT NOT NULL,workspace_id TEXT NOT NULL,session_id TEXT NOT NULL,
    state TEXT NOT NULL,archived INTEGER NOT NULL CHECK(archived IN (0,1)),sort_time TEXT NOT NULL,
    scan_tag TEXT NOT NULL,row_json TEXT NOT NULL
  ) STRICT`,
  task_query_current_scope: 'CREATE INDEX task_query_current_scope ON task_query_current(workspace_id,session_id,state,source,sort_time)',
  task_query_decisions: `CREATE TABLE task_query_decisions (
    decision_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,session_id TEXT NOT NULL,run_id TEXT NOT NULL,
    scan_tag TEXT NOT NULL,reference_json TEXT NOT NULL
  ) STRICT`,
  task_query_decision_owner: 'CREATE INDEX task_query_decision_owner ON task_query_decisions(workspace_id,session_id,run_id)'
};
const normalize = (sql: string) => sql.replace(/\s+/gu, ' ').trim().toUpperCase();

/** Rebuild only our exact disposable format; unknown constraints, indexes, or triggers stay untouched. */
export function initializeTaskQuerySnapshotSchema(database: DatabaseSync): void {
  const version = Number(database.prepare('PRAGMA user_version').get()?.user_version);
  const objects = database.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
  if (version === 0 && objects.length === 0) {
    database.exec(`BEGIN IMMEDIATE;${Object.values(schema).join(';')};PRAGMA user_version=1;COMMIT;`);
    return;
  }
  if (version !== 1 || objects.length !== Object.keys(schema).length || objects.some(object => {
    const expected = schema[String(object.name)];
    return expected === undefined || typeof object.sql !== 'string' || normalize(object.sql) !== normalize(expected);
  })) throw new Error('task_query_snapshot_schema_unknown');
}

import type { DatabaseSync } from 'node:sqlite';

/** One-time normalization. All future authority tables keep the agent_ prefix. */
export function normalizeAgentControlDatabaseNames(database: DatabaseSync): void {
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'agent_v3_*' ORDER BY name")
    .all() as unknown as { name: string }[];
  const indexes = database.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND name GLOB 'idx_agent_v3_*' ORDER BY name")
    .all() as unknown as { name: string; sql: string }[];
  for (const { name } of indexes) database.exec(`DROP INDEX ${quote(name)}`);
  for (const { name } of tables) database.exec(`ALTER TABLE ${quote(name)} RENAME TO ${quote(name.replace('agent_v3_', 'agent_'))}`);
  for (const { sql } of indexes) database.exec(sql.replaceAll('agent_v3_', 'agent_'));
}

function quote(value: string): string { return `"${value.replaceAll('"', '""')}"`; }

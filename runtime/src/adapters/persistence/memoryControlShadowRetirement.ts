import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const MEMORY_CONTROL_SHADOW_TABLES = [
  "runtime_commands",
  "agent_v2_checkpoints",
  "agent_v2_effect_payloads",
  "agent_v2_outbox",
  "agent_v2_events",
  "agent_v2_commands",
  "agent_v2_runs",
] as const;

export const MEMORY_CONTROL_SHADOW_OFFLINE_MIGRATION_REQUIRED =
  "memory_control_shadow_offline_migration_required";

export interface MemoryControlShadowPreflightResult {
  readonly databasePath: string;
  readonly presentTables: readonly string[];
}

/**
 * Read-only persistence gate run before either dedicated control store is opened.
 * A missing memory.db is valid and is never created by this inspection.
 */
export function preflightMemoryControlShadows(
  dataRoot: string,
): MemoryControlShadowPreflightResult {
  if (!path.isAbsolute(dataRoot)) {
    throw new Error("memory_control_shadow_data_root_must_be_absolute");
  }
  return preflightMemoryControlShadowsAtDatabasePath(path.join(
    path.resolve(dataRoot),
    "data",
    "agent_data",
    "memory.db",
  ));
}

/** The same read-only gate for callers that already own the memory.db path. */
export function preflightMemoryControlShadowsAtDatabasePath(
  databasePath: string,
): MemoryControlShadowPreflightResult {
  if (!path.isAbsolute(databasePath)) {
    throw new Error("memory_control_shadow_database_path_must_be_absolute");
  }
  if (!existsSync(databasePath)) {
    return { databasePath, presentTables: [] };
  }

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const inspection = inspectMemoryControlShadows(database);
    assertMemoryControlShadowsEmpty(inspection);
    return {
      databasePath,
      presentTables: inspection.presentTables,
    };
  } finally {
    database.close();
  }
}

/** Retires only empty pre-isolation scaffolding inside the caller's transaction. */
export function retireEmptyMemoryControlShadows(database: DatabaseSync): void {
  const inspection = inspectMemoryControlShadows(database);
  assertMemoryControlShadowsEmpty(inspection);
  database.exec(`
    DROP TABLE IF EXISTS agent_v2_outbox;
    DROP TABLE IF EXISTS agent_v2_effect_payloads;
    DROP TABLE IF EXISTS agent_v2_checkpoints;
    DROP TABLE IF EXISTS agent_v2_events;
    DROP TABLE IF EXISTS agent_v2_commands;
    DROP TABLE IF EXISTS agent_v2_runs;
    DROP TABLE IF EXISTS runtime_commands;
  `);
}

interface MemoryControlShadowInspection {
  readonly presentTables: readonly string[];
  readonly populatedTables: readonly string[];
}

function inspectMemoryControlShadows(
  database: DatabaseSync,
): MemoryControlShadowInspection {
  const objects = database.prepare(
    `SELECT name, type
     FROM sqlite_master
     WHERE name IN (${MEMORY_CONTROL_SHADOW_TABLES.map(() => "?").join(", ")})
     ORDER BY name`,
  ).all(...MEMORY_CONTROL_SHADOW_TABLES) as Array<{
    name: string;
    type: string;
  }>;

  const presentTables: string[] = [];
  const populatedTables: string[] = [];
  for (const object of objects) {
    if (object.type !== "table") {
      throw new Error(
        `memory_control_shadow_schema_invalid:${object.name}:${object.type}`,
      );
    }
    presentTables.push(object.name);
    const row = database.prepare(
      `SELECT EXISTS(SELECT 1 FROM ${object.name} LIMIT 1) AS populated`,
    ).get() as { populated: number };
    if (Number(row.populated) === 1) populatedTables.push(object.name);
  }
  return { presentTables, populatedTables };
}

function assertMemoryControlShadowsEmpty(
  inspection: MemoryControlShadowInspection,
): void {
  if (inspection.populatedTables.length === 0) return;
  throw new Error(
    `${MEMORY_CONTROL_SHADOW_OFFLINE_MIGRATION_REQUIRED}:`
      + inspection.populatedTables.join(","),
  );
}

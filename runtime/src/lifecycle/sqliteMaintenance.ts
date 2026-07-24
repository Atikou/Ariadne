import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { DatabaseManager } from "../context/DatabaseManager.js";
import type { LifecyclePolicy } from "./types.js";

/** cleanup / purge 后 WAL checkpoint；策略允许时 VACUUM memory + tools DB。 */
export function runSqliteMaintenance(
  memoryDb: DatabaseManager,
  toolsDbPath: string | undefined,
  policy: LifecyclePolicy,
): boolean {
  if (!policy.sqlite.walCheckpointAfterCleanup) return false;
  memoryDb.connection.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  if (policy.sqlite.enableVacuum && policy.sqlite.vacuumAfterLargeCleanup) {
    memoryDb.connection.exec("VACUUM");
  }
  if (toolsDbPath && existsSync(toolsDbPath)) {
    const toolsDb = new DatabaseSync(toolsDbPath);
    try {
      toolsDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      if (policy.sqlite.enableVacuum && policy.sqlite.vacuumAfterLargeCleanup) {
        toolsDb.exec("VACUUM");
      }
    } finally {
      toolsDb.close();
    }
  }
  return true;
}

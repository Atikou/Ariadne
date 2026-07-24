import type { WorkspaceCatalog } from "../config/workspaceCatalog.js";
import { resolveWorkspaceRootFromCatalog } from "../config/workspaceCatalog.js";
import type { SessionRecord } from "../context/types.js";

/** Returns every configured or persisted-session workspace that can own child snapshots. */
export function collectSubAgentRecoveryRoots(
  catalog: WorkspaceCatalog,
  sessions: readonly Pick<SessionRecord, "workspaceKey">[],
): string[] {
  return [
    ...catalog.entries.map((entry) => entry.resolvedRoot),
    ...sessions.map((session) =>
      resolveWorkspaceRootFromCatalog(catalog, session.workspaceKey ?? catalog.defaultKey)),
  ];
}

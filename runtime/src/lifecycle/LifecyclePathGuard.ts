import path from "node:path";

import { canonicalizePathIdentity } from "../platform/pathIdentity.js";
import { parseDbRowCleanupKind } from "./dbRowCleanup.js";
import type { CleanupAction } from "./types.js";

const OUTSIDE_ROOT_REASON = "target_outside_lifecycle_roots";

export class LifecyclePathGuard {
  private readonly allowedFileRoots: string[];

  constructor(paths: { dataDir: string; workspaceRoot: string }) {
    const dataRoot = canonicalizePathIdentity(paths.dataDir);
    const workspaceRoot = canonicalizePathIdentity(paths.workspaceRoot);
    const timelineRoot = canonicalizePathIdentity(
      path.join(paths.workspaceRoot, ".agent", "runs"),
    );
    this.allowedFileRoots = [dataRoot];
    if (isSameOrDescendant(timelineRoot, workspaceRoot)) {
      this.allowedFileRoots.push(timelineRoot);
    }
  }

  blockReason(action: CleanupAction): string | undefined {
    if (action.type === "delete_db_rows") {
      return parseDbRowCleanupKind(action.path) ? undefined : OUTSIDE_ROOT_REASON;
    }
    let targetIdentity: string;
    try {
      targetIdentity = canonicalizePathIdentity(action.path);
    } catch {
      return OUTSIDE_ROOT_REASON;
    }
    return this.allowedFileRoots.some((root) => isStrictDescendant(targetIdentity, root))
      ? undefined
      : OUTSIDE_ROOT_REASON;
  }

  constrain(action: CleanupAction): CleanupAction {
    if (!action.canDelete) {
      return {
        ...action,
        canDelete: false,
        blockedReason: action.blockedReason ?? this.blockReason(action) ?? "planner_blocked_action",
      };
    }
    const blockedReason = this.blockReason(action);
    return blockedReason
      ? { ...action, canDelete: false, blockedReason }
      : { ...action, canDelete: true, blockedReason: undefined };
  }

  assertAllowed(action: CleanupAction): void {
    const reason = this.blockReason(action);
    if (reason) {
      const error = new Error(reason) as Error & { code: string };
      error.code = "CLEANUP_TARGET_OUTSIDE_ROOTS";
      throw error;
    }
  }
}

function isSameOrDescendant(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || isRelativeDescendant(relative);
}

function isStrictDescendant(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && isRelativeDescendant(relative);
}

function isRelativeDescendant(relative: string): boolean {
  return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

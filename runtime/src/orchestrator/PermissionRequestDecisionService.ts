import type { DatabaseSync } from "node:sqlite";

import type { PausedRunStore } from "../agent/PausedRunStore.js";
import {
  PermissionRequestPersistenceError,
  PermissionRequestStore,
  PermissionRequestValidationError,
} from "../policy/PermissionRequestStore.js";
import type { SessionPermissionGrants } from "../policy/SessionPermissionGrants.js";
import {
  WorkspaceGrantStore,
  normalizeGrantTargetToRoot,
  type WorkspaceGrantInput,
  type WorkspaceScopePermission,
} from "../policy/WorkspaceScopeManager.js";
import {
  approvedPermissionItems,
  type PermissionRequestItem,
  type PermissionRequestPayload,
  type PermissionRequestRespondInput,
  type ScopedApprovedPermissions,
} from "../policy/permissionRequestTypes.js";
import type { RunStore } from "./RunStore.js";

export interface PermissionRequestDecisionResult {
  permissionRequest: PermissionRequestPayload;
  sessionGrants?: ScopedApprovedPermissions;
}

export class PermissionRequestDecisionConsistencyError extends Error {
  readonly code = "PERMISSION_REQUEST_STATE_INCONSISTENT";

  constructor(message: string) {
    super(message);
    this.name = "PermissionRequestDecisionConsistencyError";
  }
}

export class PermissionRequestDecisionService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly requests: PermissionRequestStore,
    private readonly sessionGrants: SessionPermissionGrants,
    private readonly workspaceGrants: WorkspaceGrantStore,
    private readonly runs: RunStore,
    private readonly pausedRuns: PausedRunStore,
  ) {
    const mismatchedStores = [
      ["PermissionRequestStore", requests.usesConnection(db)],
      ["SessionPermissionGrants", sessionGrants.usesConnection(db)],
      ["WorkspaceGrantStore", workspaceGrants.usesConnection(db)],
      ["RunStore", runs.usesConnection(db)],
      ["PausedRunStore", pausedRuns.usesConnection(db)],
    ].filter(([, matches]) => !matches).map(([name]) => name);
    if (mismatchedStores.length > 0) {
      throw new PermissionRequestDecisionConsistencyError(
        `权限决定事务的 Store 未共享同一 SQLite 连接：${mismatchedStores.join(", ")}`,
      );
    }
  }

  respond(
    id: string,
    input: PermissionRequestRespondInput,
  ): PermissionRequestDecisionResult | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.requests.get(id);
      if (!current || current.status !== "pending") {
        this.db.exec("COMMIT");
        return null;
      }

      const responded = this.requests.respond(id, input);
      if (!responded) {
        throw new PermissionRequestPersistenceError(
          `权限申请 ${current.id} 在决定事务中丢失 pending 状态`,
        );
      }

      const run = this.runs.get(responded.runId);
      if (!run && !isEphemeralRunId(responded.runId)) {
        throw new PermissionRequestDecisionConsistencyError(
          `权限申请 ${responded.id} 引用的 Run 不存在`,
        );
      }
      if (run && run.status !== "waiting_confirmation") {
        throw new PermissionRequestDecisionConsistencyError(
          `权限申请 ${responded.id} 引用的 Run 状态不是 waiting_confirmation`,
        );
      }
      if (run && run.sessionId !== responded.sessionId) {
        throw new PermissionRequestDecisionConsistencyError(
          `权限申请 ${responded.id} 与关联 Run 的 sessionId 不一致`,
        );
      }

      let mergedSessionGrants: ScopedApprovedPermissions | undefined;
      if (input.decision === "allow_session") {
        if (!responded.sessionId || !responded.approvedPermissions) {
          throw new PermissionRequestPersistenceError(
            `权限申请 ${responded.id} 缺少会话授权投影`,
          );
        }
        mergedSessionGrants = this.sessionGrants.merge(
          responded.sessionId,
          responded.approvedPermissions,
        );
      } else if (
        input.decision === "allow_project"
        || input.decision === "allow_workspace"
      ) {
        for (const grant of workspaceGrantInputs(responded, input.decision)) {
          this.workspaceGrants.add(grant);
        }
      }

      if (run) {
        const runStatus = input.decision === "deny"
          ? "cancelled" as const
          : "waiting_confirmation" as const;
        if (!this.runs.update(run.id, { status: runStatus })) {
          throw new PermissionRequestDecisionConsistencyError(
            `权限申请 ${responded.id} 无法更新关联 Run`,
          );
        }
      }
      if (input.decision === "deny") this.pausedRuns.delete(responded.runId);

      this.db.exec("COMMIT");
      return {
        permissionRequest: responded,
        ...(mergedSessionGrants ? { sessionGrants: mergedSessionGrants } : {}),
      };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "权限决定失败，且 SQLite 回滚失败",
        );
      }
      throw error;
    }
  }
}

function workspaceGrantInputs(
  request: PermissionRequestPayload,
  decision: "allow_project" | "allow_workspace",
): WorkspaceGrantInput[] {
  const projectId = decision === "allow_project" ? request.projectId : undefined;
  if (decision === "allow_project" && !projectId) {
    throw new PermissionRequestValidationError(
      "该权限申请没有 projectId，不能使用 allow_project",
    );
  }

  return approvedPermissionItems(request).map((item) => {
    const permission = workspacePermissionForItem(item);
    const rootTarget = item.rootPath ?? (item.type === "shell" ? undefined : item.target);
    const rootPath = rootTarget ? normalizeGrantTargetToRoot(rootTarget) : undefined;
    if (!rootPath) {
      throw new PermissionRequestValidationError(
        `${item.type} 权限项缺少可持久化的工作区根目录，请使用允许一次或本次会话`,
      );
    }
    const common = {
      rootPath,
      permissions: [permission],
      source: "user_confirmed" as const,
    };
    return decision === "allow_project"
      ? { ...common, projectId: projectId!, scope: "project" as const }
      : { ...common, scope: "workspace" as const };
  });
}

function workspacePermissionForItem(item: PermissionRequestItem): WorkspaceScopePermission {
  switch (item.type) {
    case "read_file":
      return "read";
    case "write_file":
    case "delete_file":
      return "write";
    case "shell":
      return "shell";
    case "network":
    case "dangerous":
      throw new PermissionRequestValidationError(
        `${item.type} 权限不支持项目或工作区持久授权，请使用允许一次或本次会话`,
      );
  }
}

function isEphemeralRunId(runId: string): boolean {
  return runId.startsWith("ephemeral:");
}

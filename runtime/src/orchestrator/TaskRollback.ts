import path from "node:path";

import { MODE_PERMISSIONS } from "../core/permissions.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolStorage } from "../tools/storage/ToolStorage.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import { ToolExecutionGateway } from "../agent/ToolExecutionGateway.js";
import { defaultWorkflowRouter } from "../agent/WorkflowRouter.js";

export interface TaskRollbackResult {
  attempted: number;
  restored: string[];
  errors: string[];
}

/**
 * 任务失败补偿：按 Run 关联的 tool_logs 逆序回滚 write_file / apply_patch 产生的 changeId。
 * 仅在调用方显式开启 rollbackOnFailure 时执行，避免意外抹除部分成功结果。
 */
export async function rollbackFileChangesForRun(opts: {
  registry: ToolRegistry;
  storage: ToolStorage;
  workspaceRoot: string;
  runId: string;
  sessionId?: string;
  taskId?: string;
  runGrantedPermissions?: readonly import("../core/permissions.js").ToolPermission[];
  trace?: TraceLogger;
}): Promise<TaskRollbackResult> {
  const changeIds = opts.storage.listChangeIdsForRequest(opts.runId);
  const restored: string[] = [];
  const errors: string[] = [];

  opts.trace?.write({
    type: "task_rollback_start",
    runId: opts.runId,
    taskId: opts.taskId,
    changeCount: changeIds.length,
  });

  const gateway = new ToolExecutionGateway(opts.registry);

  for (const changeId of [...changeIds].reverse()) {
    const change = opts.storage.getFileChange(changeId);
    const rollbackRoot = change?.workspaceRoot ?? opts.workspaceRoot;
    const rollbackPath =
      change?.normalizedPath ??
      (change?.workspaceRoot ? path.resolve(change.workspaceRoot, change.path) : change?.path);
    const result = await gateway.run({
      toolName: "rollback_change",
      input: rollbackPath ? { changeId, path: rollbackPath } : { changeId },
      source: "rollback",
      budgetBucket: "rollback",
      workspaceRoot: rollbackRoot,
      sessionId: opts.sessionId,
      requestId: opts.runId,
      taskId: opts.taskId,
      allowedPermissions: MODE_PERMISSIONS.task,
      runGrantedPermissions: opts.runGrantedPermissions,
      intent: "edit",
      permissionPolicy: "confirmBeforeEdit",
      mode: "implement",
      workflowRoute: defaultWorkflowRouter.routeIntent("edit"),
    });
    if (result.ok) {
      const output = result.output as { restoredFiles?: string[]; deletedFiles?: string[] };
      restored.push(...(output.restoredFiles ?? []), ...(output.deletedFiles ?? []));
    } else {
      errors.push(`${changeId}: ${result.error}`);
    }
  }

  opts.trace?.write({
    type: "task_rollback_end",
    runId: opts.runId,
    taskId: opts.taskId,
    restoredCount: restored.length,
    errorCount: errors.length,
  });

  return { attempted: changeIds.length, restored, errors };
}

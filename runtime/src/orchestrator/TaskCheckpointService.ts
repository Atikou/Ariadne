import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { FileChangeRecord } from "../tools/storage/ToolStorage.js";
import { resolveInsideWorkspace } from "../tools/pathSafe.js";

export type TaskCheckpointComparison =
  | "matches"
  | "modified"
  | "missing"
  | "unexpected_file";

export interface TaskCheckpointView {
  checkpointId: string;
  runId: string;
  toolName: string;
  path: string;
  beforeHash?: string;
  afterHash?: string;
  currentHash?: string;
  comparison: TaskCheckpointComparison;
  restorable: boolean;
  diff?: string;
  createdAt: string;
}

export class TaskCheckpointService {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly defaultWorkspaceRoot: string,
  ) {}

  async list(runId: string): Promise<TaskCheckpointView[]> {
    const storage = this.requireStorage();
    return Promise.all(
      storage.listFileChangesForRequest(runId).map((record) =>
        this.project(runId, record)),
    );
  }

  async get(runId: string, checkpointId: string): Promise<TaskCheckpointView | undefined> {
    const record = this.ownedRecord(runId, checkpointId);
    return record ? this.project(runId, record) : undefined;
  }

  async restore(input: {
    runId: string;
    checkpointId: string;
    sessionId?: string;
    taskId?: string;
  }): Promise<{ source: TaskCheckpointView; restore: TaskCheckpointView }> {
    const sourceRecord = this.ownedRecord(input.runId, input.checkpointId);
    if (!sourceRecord) throw new Error("task_checkpoint_not_found");
    const source = await this.project(input.runId, sourceRecord);
    if (source.comparison !== "matches") {
      throw new Error(`task_checkpoint_restore_conflict:${source.comparison}:${source.path}`);
    }
    if (!source.restorable) throw new Error("task_checkpoint_not_restorable");
    const workspaceRoot = sourceRecord.workspaceRoot ?? this.defaultWorkspaceRoot;
    const result = await this.registry.run("rollback_change", {
      changeId: input.checkpointId,
    }, {
      workspaceRoot,
      requestId: input.runId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      allowedPermissions: ["write"],
    });
    if (!result.ok) throw new Error(result.error ?? result.message);
    const restoreId = (result.output as { changeId?: string } | undefined)?.changeId;
    if (!restoreId) throw new Error("task_checkpoint_restore_record_missing");
    const restoreRecord = this.ownedRecord(input.runId, restoreId);
    if (!restoreRecord) throw new Error("task_checkpoint_restore_record_missing");
    return {
      source,
      restore: await this.project(input.runId, restoreRecord),
    };
  }

  private ownedRecord(runId: string, checkpointId: string): FileChangeRecord | undefined {
    return this.requireStorage()
      .listFileChangesForRequest(runId)
      .find((record) => record.id === checkpointId);
  }

  private async project(runId: string, record: FileChangeRecord): Promise<TaskCheckpointView> {
    const workspaceRoot = record.workspaceRoot ?? this.defaultWorkspaceRoot;
    const fullPath = resolveInsideWorkspace(workspaceRoot, record.path);
    const currentHash = await fileHash(fullPath);
    const comparison: TaskCheckpointComparison = record.afterHash === undefined
      ? currentHash === undefined ? "matches" : "unexpected_file"
      : currentHash === undefined ? "missing"
        : currentHash === record.afterHash ? "matches" : "modified";
    return {
      checkpointId: record.id,
      runId,
      toolName: record.toolName,
      path: record.path.replace(/\\/gu, "/"),
      beforeHash: record.beforeHash,
      afterHash: record.afterHash,
      currentHash,
      comparison,
      restorable: record.beforeHash === undefined || Boolean(record.backupPath),
      diff: record.diff,
      createdAt: record.createdAt,
    };
  }

  private requireStorage() {
    const storage = this.registry.getStorage();
    if (!storage) throw new Error("task_checkpoint_storage_unavailable");
    return storage;
  }
}

async function fileHash(filePath: string): Promise<string | undefined> {
  try {
    return createHash("sha256").update(await readFile(filePath)).digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

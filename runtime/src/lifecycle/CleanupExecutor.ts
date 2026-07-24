import { readFileSync } from "node:fs";

import type { DatabaseManager } from "../context/DatabaseManager.js";
import { toPublicError } from "../util/publicError.js";
import { atomicWriteFile, fileAgeDays, safeDeleteDirectory, safeDeleteFile } from "./fsUtils.js";
import { compactSchedulerJournalFile } from "./schedulerJournalCompact.js";
import {
  estimateDbRowBytes,
  parseDbRowCleanupKind,
  purgeSoftDeletedMemories,
  purgeStaleRoutingRows,
} from "./dbRowCleanup.js";
import { CleanupJournal } from "./CleanupJournal.js";
import { LifecyclePathGuard } from "./LifecyclePathGuard.js";
import { CleanupActionSchema, CleanupApplyResultSchema } from "./StorageLifecycleContracts.js";
import { pruneTraceSegmentFields } from "./traceFieldRetention.js";
import type { CleanupAction, CleanupApplyResult, LifecyclePolicy } from "./types.js";

export class CleanupExecutor {
  constructor(
    private readonly journal: CleanupJournal,
    private readonly policy: LifecyclePolicy,
    private readonly memoryDb: DatabaseManager,
    private readonly pathGuard: LifecyclePathGuard,
  ) {}

  apply(actions: CleanupAction[], cleanupRunId: string, startedAt: number): CleanupApplyResult {
    const validatedActions = CleanupActionSchema.array().parse(actions);
    const result: CleanupApplyResult = {
      cleanupRunId,
      mode: "apply",
      startedAt,
      endedAt: 0,
      applied: 0,
      skipped: 0,
      failed: 0,
      bytesFreed: 0,
      actions: [],
    };

    for (const action of validatedActions) {
      const actionStarted = Date.now();
      if (!action.canDelete) {
        this.recordSkipped(
          result,
          action,
          cleanupRunId,
          actionStarted,
          action.blockedReason ?? "blocked",
        );
        continue;
      }

      if (action.risk !== "low" && this.policy.cleanup.requireDryRunBeforeApply) {
        this.recordSkipped(
          result,
          action,
          cleanupRunId,
          actionStarted,
          "non-low risk requires explicit policy override",
        );
        continue;
      }

      try {
        const freed = this.executeOne(action);
        result.applied += 1;
        result.bytesFreed += freed;
        result.actions.push({
          actionId: action.actionId,
          type: action.type,
          target: action.path,
          status: "success",
          bytesFreed: freed,
        });
        this.journal.append({
          cleanupRunId,
          actionId: action.actionId,
          type: action.type,
          target: action.path,
          status: "success",
          bytesFreed: freed,
          startedAt: actionStarted,
          endedAt: Date.now(),
        });
      } catch (error) {
        result.failed += 1;
        const msg = toPublicError(error, "cleanup action failed").message;
        result.actions.push({
          actionId: action.actionId,
          type: action.type,
          target: action.path,
          status: "failed",
          bytesFreed: 0,
          error: msg,
        });
        this.journal.append({
          cleanupRunId,
          actionId: action.actionId,
          type: action.type,
          target: action.path,
          status: "failed",
          bytesFreed: 0,
          startedAt: actionStarted,
          endedAt: Date.now(),
          error: msg,
        });
      }
    }

    result.endedAt = Date.now();
    return CleanupApplyResultSchema.parse(result);
  }

  private executeOne(action: CleanupAction): number {
    this.pathGuard.assertAllowed(action);
    switch (action.type) {
      case "delete_file":
        safeDeleteFile(action.path);
        return action.bytes;
      case "delete_directory":
        safeDeleteDirectory(action.path);
        return action.bytes;
      case "compact_jsonl":
        return action.category === "scheduler"
          ? compactSchedulerJournalFile(action.path)
          : this.compactNotifications(action.path);
      case "delete_db_rows":
        return this.deleteDbRows(action);
      case "rewrite_file":
        return action.category === "trace"
          ? this.pruneTraceSegment(action.path)
          : this.rewriteFilePlaceholder(action);
      default:
        throw new Error(`unsupported action type: ${action.type}`);
    }
  }

  private deleteDbRows(action: CleanupAction): number {
    const kind = parseDbRowCleanupKind(action.path);
    if (!kind) throw new Error(`unknown db cleanup target: ${action.path}`);
    const rows =
      kind === "soft_deleted_memories"
        ? purgeSoftDeletedMemories(this.memoryDb, this.policy)
        : purgeStaleRoutingRows(this.memoryDb, this.policy);
    return estimateDbRowBytes(rows);
  }

  private pruneTraceSegment(filePath: string): number {
    const result = pruneTraceSegmentFields(filePath, this.policy);
    return result.bytesSaved;
  }

  private rewriteFilePlaceholder(action: CleanupAction): number {
    throw new Error(`rewrite_file not supported for category: ${action.category}`);
  }

  private compactNotifications(filePath: string): number {
    const text = readFileSync(filePath, "utf-8");
    const lines = text.split("\n").filter(Boolean);
    const ttl = this.policy.retentionDays.readNotifications;
    const now = Date.now();
    const consumed = new Set<string>();

    for (const line of lines) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (parsed.op === "consume" && Array.isArray(parsed.ids)) {
        for (const id of parsed.ids) {
          if (typeof id === "string") consumed.add(id);
        }
      }
    }

    const kept: string[] = [];
    let removedBytes = 0;

    for (const line of lines) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        kept.push(line);
        continue;
      }
      if (parsed.op === "consume") {
        kept.push(line);
        continue;
      }
      const id = typeof parsed.id === "string" ? parsed.id : undefined;
      const ts = typeof parsed.timestamp === "string" ? parsed.timestamp : undefined;
      const isConsumed = parsed.consumed === true || (id != null && consumed.has(id));
      if (!isConsumed || !ts) {
        kept.push(line);
        continue;
      }
      const mtimeMs = Date.parse(ts);
      if (Number.isNaN(mtimeMs) || fileAgeDays(mtimeMs, now) < ttl) {
        kept.push(line);
        continue;
      }
      removedBytes += Buffer.byteLength(line, "utf-8") + 1;
    }

    atomicWriteFile(filePath, kept.length > 0 ? `${kept.join("\n")}\n` : "");
    return removedBytes;
  }

  private recordSkipped(
    result: CleanupApplyResult,
    action: CleanupAction,
    cleanupRunId: string,
    startedAt: number,
    reason: string,
  ): void {
    const endedAt = Date.now();
    result.skipped += 1;
    result.actions.push({
      actionId: action.actionId,
      type: action.type,
      target: action.path,
      status: "skipped",
      bytesFreed: 0,
      error: reason,
    });
    this.journal.append({
      cleanupRunId,
      actionId: action.actionId,
      type: action.type,
      target: action.path,
      status: "skipped",
      bytesFreed: 0,
      startedAt,
      endedAt,
      error: reason,
    });
  }
}

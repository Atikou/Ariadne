import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { DatabaseManager } from "../context/DatabaseManager.js";
import { CleanupExecutor } from "./CleanupExecutor.js";
import { CleanupJournal } from "./CleanupJournal.js";
import { CleanupLock } from "./CleanupLock.js";
import { CleanupPlanner } from "./CleanupPlanner.js";
import { LifecyclePathGuard } from "./LifecyclePathGuard.js";
import { loadLifecyclePolicy, lifecycleDir } from "./policy.js";
import { StorageInventoryService } from "./StorageInventoryService.js";
import {
  CleanupApplyResultSchema,
  CleanupPreviewRequestSchema,
  CleanupPreviewResultSchema,
  CleanupRunIdSchema,
  StorageUsageResultSchema,
  type CleanupApplyFailure,
} from "./StorageLifecycleContracts.js";
import {
  cleanupSessionArtifacts,
  deleteRunArtifacts,
  type RunArtifactCleanupResult,
} from "./SessionArtifactCleaner.js";
import type { TraceCatalog } from "../trace/traceCatalog.js";
import { purgeSessionPrivacy, type SessionPurgeResult } from "./SessionPrivacyPurger.js";
import { runSqliteMaintenance } from "./sqliteMaintenance.js";
import type {
  CleanupApplyRequest,
  CleanupApplyResult,
  CleanupPreviewReport,
  CleanupPreviewRequest,
  LifecyclePolicy,
  StorageUsageReport,
} from "./types.js";

export type { SessionPurgeResult } from "./SessionPrivacyPurger.js";

export interface DataLifecycleServiceDeps {
  dataDir: string;
  workspaceRoot: string;
  traceFile: string;
  notificationFile: string;
  schedulerJournalFile: string;
  memoryDb: DatabaseManager;
  toolsDbPath?: string;
  tracesDir: string;
  traceCatalog: TraceCatalog;
  getActiveRunIds: () => string[];
}

interface StoredPreview {
  report: CleanupPreviewReport;
  request: CleanupPreviewRequest;
  expiresAt: number;
}

export class DataLifecycleService {
  private readonly policy: LifecyclePolicy;
  private readonly inventory: StorageInventoryService;
  private readonly journal: CleanupJournal;
  private readonly pathGuard: LifecyclePathGuard;
  private readonly previews = new Map<string, StoredPreview>();

  constructor(private readonly deps: DataLifecycleServiceDeps) {
    this.policy = loadLifecyclePolicy(deps.dataDir);
    this.inventory = new StorageInventoryService({
      dataDir: deps.dataDir,
      workspaceRoot: deps.workspaceRoot,
      traceFile: deps.traceFile,
      notificationFile: deps.notificationFile,
      schedulerJournalFile: deps.schedulerJournalFile,
      memoryDbPath: deps.memoryDb.dbPath,
      toolsDbPath: deps.toolsDbPath,
    });
    this.journal = new CleanupJournal(deps.dataDir);
    this.pathGuard = new LifecyclePathGuard({
      dataDir: deps.dataDir,
      workspaceRoot: deps.workspaceRoot,
    });
  }

  getPolicy() {
    return this.policy;
  }

  getUsage(): StorageUsageReport {
    return StorageUsageResultSchema.parse(this.inventory.scan());
  }

  /** 已执行清理批次的历史（最近优先），用于审计「实际删了什么」。 */
  listCleanupRuns(limit = 50) {
    return this.journal.listRecentRuns(limit);
  }

  preview(request: CleanupPreviewRequest = {}): CleanupPreviewReport {
    const normalizedRequest = CleanupPreviewRequestSchema.parse(cloneJson(request));
    const actions = this.applyPathSafety(this.createPlanner().plan(normalizedRequest));
    const deletable = actions.filter((a) => a.canDelete);
    const startedAt = Date.now();
    const report = CleanupPreviewResultSchema.parse({
      cleanupRunId: `cleanup_${formatRunIdDate()}_${randomUUID()}`,
      mode: "dry-run",
      startedAt,
      expiresAt: startedAt + 60 * 60 * 1000,
      summary: {
        candidateFiles: deletable.filter((a) => a.type === "delete_file" || a.type === "delete_directory").length,
        candidateDbRows: deletable
          .filter((a) => a.type === "delete_db_rows")
          .reduce((s, a) => s + Math.max(1, Math.round(a.bytes / 384)), 0),
        estimatedBytesToFree: deletable.reduce((s, a) => s + a.bytes, 0),
      },
      actions,
      warnings: actions.filter((a) => !a.canDelete).map((a) => `${a.path}: ${a.blockedReason ?? "blocked"}`),
    });
    this.storePreview(report, normalizedRequest);
    return report;
  }

  apply(request: CleanupApplyRequest): CleanupApplyResult | CleanupApplyFailure {
    if (request.confirm !== true) {
      return cleanupFailure(400, "CLEANUP_CONFIRM_REQUIRED", "apply 需要 confirm: true");
    }
    if (!CleanupRunIdSchema.safeParse(request.cleanupRunId).success) {
      return cleanupFailure(400, "CLEANUP_RUN_ID_INVALID", "cleanupRunId 格式无效");
    }
    // 磁盘 preview 仅作审计快照，不能在重启后恢复为执行授权。
    const stored = this.previews.get(request.cleanupRunId);
    if (!stored) {
      return cleanupFailure(
        404,
        "CLEANUP_PREVIEW_NOT_FOUND",
        `未找到清理预览：${request.cleanupRunId}，请先调用 preview`,
      );
    }
    if (Date.now() > stored.expiresAt) {
      this.previews.delete(request.cleanupRunId);
      this.deletePreviewFile(request.cleanupRunId);
      return cleanupFailure(410, "CLEANUP_PREVIEW_EXPIRED", "清理预览已过期，请重新 preview");
    }

    const lock = new CleanupLock(this.deps.dataDir, this.policy.cleanup.lockTimeoutSeconds);
    if (!lock.acquire()) {
      return cleanupFailure(409, "CLEANUP_LOCKED", "另一项清理任务正在执行，请稍后重试");
    }

    try {
      const freshActions = this.applyPathSafety(this.createPlanner().plan(stored.request));
      const freshAllowed = new Set(
        freshActions
          .filter((action) => action.canDelete && action.risk === "low")
          .map(cleanupActionIdentity),
      );
      const executionActions = stored.report.actions.map((action) =>
        this.revalidateAction(action, freshAllowed),
      );
      const executor = new CleanupExecutor(
        this.journal,
        this.policy,
        this.deps.memoryDb,
        this.pathGuard,
      );
      const result = CleanupApplyResultSchema.parse(
        executor.apply(executionActions, request.cleanupRunId, stored.report.startedAt),
      );
      if (result.applied > 0) {
        runSqliteMaintenance(this.deps.memoryDb, this.deps.toolsDbPath, this.policy);
      }
      return result;
    } finally {
      lock.release();
      this.previews.delete(request.cleanupRunId);
      this.deletePreviewFile(request.cleanupRunId);
    }
  }

  /** 策略 `cleanup.autoEnabled` 为 true 时由服务端定时调用：preview safe + apply。 */
  runAutoSafeCleanup(): CleanupApplyResult | { autoSkipped: true; reason: string } {
    if (!this.policy.cleanup.autoEnabled) {
      return { autoSkipped: true, reason: "autoEnabled=false" };
    }
    const report = this.preview({ scope: "safe" });
    const deletable = report.actions.filter((a) => a.canDelete && a.risk === "low");
    if (deletable.length === 0) {
      return { autoSkipped: true, reason: "no_deletable_candidates" };
    }
    const result = this.apply({ cleanupRunId: report.cleanupRunId, confirm: true });
    if ("error" in result) {
      throw new Error(result.error);
    }
    return result;
  }

  onSessionDeleted(sessionId: string, runIds: string[]): { runIds: string[]; bytesFreed: number } {
    if (runIds.length === 0) {
      return { runIds: [], bytesFreed: 0 };
    }
    const result = cleanupSessionArtifacts({
      dataDir: this.deps.dataDir,
      workspaceRoot: this.deps.workspaceRoot,
      sessionId,
      runIds,
      deleteTimeline: this.policy.privacy.deleteActivityRunsOnSessionDelete,
    });
    return { runIds, bytesFreed: result.bytesFreed };
  }

  onRunDeleted(runId: string, sessionId?: string): RunArtifactCleanupResult {
    return deleteRunArtifacts({
      dataDir: this.deps.dataDir,
      workspaceRoot: this.deps.workspaceRoot,
      runId,
      sessionId,
      removeTimeline: this.policy.privacy.deleteActivityRunsOnSessionDelete,
    });
  }

  purgeSessionPrivacy(sessionId: string, runIds: string[]): SessionPurgeResult {
    if (!this.policy.privacy.supportSessionPurge) {
      throw new Error("policy.privacy.supportSessionPurge 未启用");
    }
    return purgeSessionPrivacy(
      {
        dataDir: this.deps.dataDir,
        workspaceRoot: this.deps.workspaceRoot,
        memoryDb: this.deps.memoryDb,
        toolsDbPath: this.deps.toolsDbPath,
        traceCatalog: this.deps.traceCatalog,
        notificationFile: this.deps.notificationFile,
        schedulerJournalFile: this.deps.schedulerJournalFile,
        policy: this.policy,
      },
      sessionId,
      runIds,
    );
  }

  private createPlanner(): CleanupPlanner {
    return new CleanupPlanner(
      {
        dataDir: this.deps.dataDir,
        workspaceRoot: this.deps.workspaceRoot,
        traceFile: this.deps.traceFile,
        tracesDir: this.deps.tracesDir,
        notificationFile: this.deps.notificationFile,
        schedulerJournalFile: this.deps.schedulerJournalFile,
        memoryDb: this.deps.memoryDb,
        getActiveRunIds: this.deps.getActiveRunIds,
      },
      this.policy,
    );
  }

  private applyPathSafety(actions: CleanupPreviewReport["actions"]): CleanupPreviewReport["actions"] {
    return actions.map((action) => this.pathGuard.constrain(action));
  }

  private revalidateAction(
    action: CleanupPreviewReport["actions"][number],
    freshAllowed: ReadonlySet<string>,
  ): CleanupPreviewReport["actions"][number] {
    if (!action.canDelete) return action;
    if (action.risk !== "low") {
      return { ...action, canDelete: false, blockedReason: "only_low_risk_actions_can_apply" };
    }
    const pathBlocked = this.pathGuard.blockReason(action);
    if (pathBlocked) {
      return { ...action, canDelete: false, blockedReason: pathBlocked };
    }
    if (!freshAllowed.has(cleanupActionIdentity(action))) {
      return { ...action, canDelete: false, blockedReason: "candidate_changed_since_preview" };
    }
    return { ...action, blockedReason: undefined };
  }

  private storePreview(report: CleanupPreviewReport, request: CleanupPreviewRequest): void {
    const stored = { report: cloneJson(report), request: cloneJson(request), expiresAt: report.expiresAt };
    this.previews.set(report.cleanupRunId, stored);
    const dir = path.join(lifecycleDir(this.deps.dataDir), "previews");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, `${report.cleanupRunId}.json`),
      JSON.stringify(stored),
      "utf-8",
    );
  }

  private deletePreviewFile(cleanupRunId: string): void {
    if (!CleanupRunIdSchema.safeParse(cleanupRunId).success) return;
    const file = path.join(lifecycleDir(this.deps.dataDir), "previews", `${cleanupRunId}.json`);
    if (existsSync(file)) {
      try {
        unlinkSync(file);
      } catch {
        // ignore
      }
    }
  }
}

function cleanupActionIdentity(action: CleanupPreviewReport["actions"][number]): string {
  return JSON.stringify([action.type, path.normalize(action.path), action.category, action.risk]);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cleanupFailure(
  status: CleanupApplyFailure["status"],
  code: CleanupApplyFailure["code"],
  error: string,
): CleanupApplyFailure {
  return { status, code, error };
}

function formatRunIdDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

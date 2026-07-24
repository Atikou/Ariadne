import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { DatabaseManager } from "../context/DatabaseManager.js";
import { listSegmentFiles } from "../trace/traceCatalog.js";
import {
  countSoftDeletedMemories,
  countStaleRoutingRows,
  estimateDbRowBytes,
} from "./dbRowCleanup.js";
import { ActivityRunStore } from "../agent/timeline/ActivityRunStore.js";
import { fileAgeDays, walkFiles } from "./fsUtils.js";
import type { LifecyclePolicy } from "./types.js";
import type {
  CleanupAction,
  CleanupPreviewRequest,
  CleanupRisk,
  StorageCategory,
} from "./types.js";

const SAFE_CATEGORIES: StorageCategory[] = [
  "temp",
  "cache",
  "reportCache",
  "notifications",
  "scheduler",
  "sqlite_memory",
];

const RISK_ORDER: Record<CleanupRisk, number> = { low: 0, medium: 1, high: 2 };

export interface CleanupPlannerDeps {
  dataDir: string;
  workspaceRoot: string;
  traceFile: string;
  tracesDir: string;
  notificationFile: string;
  schedulerJournalFile: string;
  memoryDb: DatabaseManager;
  getActiveRunIds: () => string[];
}

export class CleanupPlanner {
  constructor(
    private readonly deps: CleanupPlannerDeps,
    private readonly policy: LifecyclePolicy,
  ) {}

  plan(request: CleanupPreviewRequest = {}): CleanupAction[] {
    const scope = request.scope ?? "safe";
    const maxRisk = request.maxRisk ?? (scope === "safe" ? "low" : "medium");
    const include = request.include ?? (scope === "safe" ? SAFE_CATEGORIES : undefined);
    const activeRuns = new Set(this.deps.getActiveRunIds());
    const now = Date.now();
    const actions: CleanupAction[] = [];

    const push = (partial: Omit<CleanupAction, "actionId" | "canDelete"> & { canDelete?: boolean }): void => {
      if (include && !include.includes(partial.category)) return;
      if (RISK_ORDER[partial.risk] > RISK_ORDER[maxRisk]) return;
      if (request.olderThanDays != null) {
        // path-level age filter handled per action
      }
      const blocked = this.blockReason(partial.path, activeRuns);
      actions.push({
        actionId: `action_${randomUUID().slice(0, 8)}`,
        canDelete: partial.canDelete ?? !blocked,
        blockedReason: blocked,
        ...partial,
      });
    };

    this.planTemp(push, now, request.olderThanDays);
    this.planCache(push, now, request.olderThanDays);
    this.planReportCache(push, now, request.olderThanDays);
    this.planNotifications(push, now);
    this.planSchedulerJournal(push, now);
    this.planSoftDeletedMemories(push);
    if (scope !== "safe") {
      this.planStaleRoutingLogs(push);
      this.planTraceFieldRetention(push, now);
      this.planTraceRawQuota(push);
    }
    if (scope !== "safe" || include?.includes("timeline")) {
      this.planTimelineRawEvents(push, now, activeRuns);
    }

    return actions;
  }

  private blockReason(targetPath: string, activeRuns: Set<string>): string | undefined {
    for (const runId of activeRuns) {
      if (targetPath.includes(runId)) {
        return `active run ${runId}`;
      }
    }
    const agentRuns = path.join(this.deps.workspaceRoot, ".agent", "runs");
    if (targetPath.startsWith(agentRuns)) {
      const seg = targetPath.slice(agentRuns.length + 1).split(path.sep)[0];
      if (seg && activeRuns.has(seg)) {
        return `active timeline run ${seg}`;
      }
    }
    return undefined;
  }

  private planTemp(
    push: (a: Omit<CleanupAction, "actionId" | "canDelete"> & { canDelete?: boolean }) => void,
    now: number,
    olderThanDays?: number | null,
  ): void {
    const tempDir = path.join(this.deps.dataDir, "temp");
    const ttl = olderThanDays ?? this.policy.retentionDays.temp;
    const files = walkFiles(tempDir).sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = files.reduce((s, f) => s + f.size, 0);
    const quota = this.policy.quotas.tempBytes;

    for (const f of files) {
      const age = fileAgeDays(f.mtimeMs, now);
      const overTtl = age >= ttl;
      const overQuota = total > quota;
      if (!overTtl && !overQuota) continue;
      push({
        type: "delete_file",
        path: f.path,
        reason: overTtl ? `temp older than ${ttl} day(s)` : "temp quota exceeded",
        bytes: f.size,
        risk: "low",
        category: "temp",
      });
      total -= f.size;
    }
  }

  private planCache(
    push: (a: Omit<CleanupAction, "actionId" | "canDelete"> & { canDelete?: boolean }) => void,
    now: number,
    olderThanDays?: number | null,
  ): void {
    const cacheDir = path.join(this.deps.dataDir, "cache");
    const ttl = olderThanDays ?? this.policy.retentionDays.fileCache;
    const files = walkFiles(cacheDir).sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = files.reduce((s, f) => s + f.size, 0);
    const quota = this.policy.quotas.cacheBytes;

    for (const f of files) {
      const age = fileAgeDays(f.mtimeMs, now);
      const overTtl = age >= ttl;
      const overQuota = total > quota;
      if (!overTtl && !overQuota) continue;
      push({
        type: "delete_file",
        path: f.path,
        reason: overTtl ? `cache older than ${ttl} day(s)` : "cache quota exceeded",
        bytes: f.size,
        risk: "low",
        category: "cache",
      });
      total -= f.size;
    }
  }

  private planReportCache(
    push: (a: Omit<CleanupAction, "actionId" | "canDelete"> & { canDelete?: boolean }) => void,
    now: number,
    olderThanDays?: number | null,
  ): void {
    const dir = path.join(this.deps.dataDir, "reports", "cache");
    const ttl = olderThanDays ?? this.policy.retentionDays.reportCache;
    const files = walkFiles(dir).sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = files.reduce((s, f) => s + f.size, 0);
    const quota = this.policy.quotas.reportCacheBytes;

    for (const f of files) {
      const age = fileAgeDays(f.mtimeMs, now);
      const overTtl = age >= ttl;
      const overQuota = total > quota;
      if (!overTtl && !overQuota) continue;
      push({
        type: "delete_file",
        path: f.path,
        reason: overTtl ? `report cache older than ${ttl} day(s)` : "report cache quota exceeded",
        bytes: f.size,
        risk: "low",
        category: "reportCache",
      });
      total -= f.size;
    }
  }

  private planNotifications(
    push: (a: Omit<CleanupAction, "actionId" | "canDelete"> & { canDelete?: boolean }) => void,
    now: number,
  ): void {
    const file = this.deps.notificationFile;
    let text: string;
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      return;
    }
    if (!text.trim()) return;

    const ttl = this.policy.retentionDays.readNotifications;
    const lines = text.split("\n").filter(Boolean);
    const consumed = new Set<string>();
    let removable = 0;
    let removableBytes = 0;

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

    for (const line of lines) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (parsed.op === "consume") continue;
      const id = typeof parsed.id === "string" ? parsed.id : undefined;
      const ts = typeof parsed.timestamp === "string" ? parsed.timestamp : undefined;
      const isConsumed = parsed.consumed === true || (id != null && consumed.has(id));
      if (!isConsumed || !ts) continue;
      const mtimeMs = Date.parse(ts);
      if (Number.isNaN(mtimeMs)) continue;
      if (fileAgeDays(mtimeMs, now) >= ttl) {
        removable += 1;
        removableBytes += Buffer.byteLength(line, "utf-8") + 1;
      }
    }

    if (removable > 0) {
      push({
        type: "compact_jsonl",
        path: file,
        reason: `remove ${removable} consumed notification(s) older than ${ttl} day(s)`,
        bytes: removableBytes,
        risk: "low",
        category: "notifications",
      });
    }
  }

  private planSchedulerJournal(
    push: (a: Omit<CleanupAction, "actionId" | "canDelete"> & { canDelete?: boolean }) => void,
    now: number,
  ): void {
    const file = this.deps.schedulerJournalFile;
    let text: string;
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      return;
    }
    if (!text.trim()) return;

    const ttl = this.policy.retentionDays.completedSchedulerJournal;
    const lines = text.split("\n").filter(Boolean);
    let hasStaleHistory = false;
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as { time?: string };
        const ts = parsed.time ? Date.parse(parsed.time) : Number.NaN;
        if (!Number.isNaN(ts) && fileAgeDays(ts, now) >= ttl) {
          hasStaleHistory = true;
          break;
        }
      } catch {
        continue;
      }
    }
    if (!hasStaleHistory || lines.length < 2) return;

    const minimalBytes = estimateCompactSchedulerJournalBytes(lines);
    const currentBytes = Buffer.byteLength(text, "utf-8");
    const removableBytes = Math.max(0, currentBytes - minimalBytes);
    if (removableBytes <= 0) return;

    push({
      type: "compact_jsonl",
      path: file,
      reason: `compact scheduler journal history older than ${ttl} day(s)`,
      bytes: removableBytes,
      risk: "low",
      category: "scheduler",
    });
  }

  private planSoftDeletedMemories(
    push: (a: Omit<CleanupAction, "actionId" | "canDelete"> & { canDelete?: boolean }) => void,
  ): void {
    const rows = countSoftDeletedMemories(this.deps.memoryDb, this.policy);
    if (rows === 0) return;
    push({
      type: "delete_db_rows",
      path: "db:memory:soft_deleted_memories",
      reason: `purge ${rows} deactivated memory row(s) older than ${this.policy.retentionDays.softDeletedRows} day(s)`,
      bytes: estimateDbRowBytes(rows),
      risk: "low",
      category: "sqlite_memory",
    });
  }

  private planStaleRoutingLogs(
    push: (a: Omit<CleanupAction, "actionId" | "canDelete"> & { canDelete?: boolean }) => void,
  ): void {
    const rows = countStaleRoutingRows(this.deps.memoryDb, this.policy);
    if (rows === 0) return;
    push({
      type: "delete_db_rows",
      path: "db:memory:stale_routing_logs",
      reason: `purge ${rows} routing log row(s) older than ${this.policy.retentionDays.routeDetails} day(s)`,
      bytes: estimateDbRowBytes(rows),
      risk: "low",
      category: "routing",
    });
  }

  private planTraceFieldRetention(
    push: (a: Omit<CleanupAction, "actionId" | "canDelete"> & { canDelete?: boolean }) => void,
    now: number,
  ): void {
    const minTtl = Math.min(
      this.policy.retentionDays.toolArgs,
      this.policy.retentionDays.toolOutput,
      this.policy.retentionDays.traceRawSuccess,
    );
    for (const segment of listSegmentFiles(this.deps.tracesDir)) {
      if (!existsSync(segment)) continue;
      if (fileAgeDays(statSync(segment).mtimeMs, now) < minTtl) continue;
      push({
        type: "rewrite_file",
        path: segment,
        reason: "prune expired trace verbose fields (toolArgs/traceRaw/toolOutput)",
        bytes: 4096,
        risk: "low",
        category: "trace",
      });
    }
  }

  private planTraceRawQuota(
    push: (a: Omit<CleanupAction, "actionId" | "canDelete"> & { canDelete?: boolean }) => void,
  ): void {
    const quota = this.policy.quotas.traceRawBytes;
    const segments = listSegmentFiles(this.deps.tracesDir).filter((p) => existsSync(p));
    if (segments.length === 0) return;
    const files = segments.map((p) => ({ path: p, size: statSync(p).size }));
    let total = files.reduce((sum, f) => sum + f.size, 0);
    if (total <= quota) return;
    for (const file of files) {
      if (total <= quota) break;
      push({
        type: "delete_file",
        path: file.path,
        reason: `traceRawBytes quota exceeded (${quota}); delete oldest segment first`,
        bytes: file.size,
        risk: "low",
        category: "trace",
      });
      total -= file.size;
    }
  }

  private planTimelineRawEvents(
    push: (a: Omit<CleanupAction, "actionId" | "canDelete"> & { canDelete?: boolean }) => void,
    now: number,
    activeRuns: Set<string>,
  ): void {
    const store = new ActivityRunStore(this.deps.workspaceRoot);
    for (const runId of store.listRunIds()) {
      if (activeRuns.has(runId)) continue;
      const manifest = store.loadManifest(runId);
      if (!manifest) continue;
      if (manifest.pinned) continue;
      if (manifest.status === "running" || manifest.status === "pending") continue;

      const runDir = path.join(this.deps.workspaceRoot, ".agent", "runs", runId);
      const summaryFile = path.join(runDir, "summary.md");
      if (!existsSync(summaryFile)) continue;

      const ageAnchor = manifest.completedAt ?? manifest.createdAt;
      const ttl =
        manifest.status === "failed" || manifest.status === "cancelled"
          ? this.policy.retentionDays.runRawEventsFailed
          : this.policy.retentionDays.runRawEventsSuccess;
      if (fileAgeDays(ageAnchor, now) < ttl) continue;

      for (const name of ["events.jsonl", "raw-tool-calls.jsonl"]) {
        const file = path.join(runDir, name);
        if (!existsSync(file)) continue;
        const bytes = statSync(file).size;
        push({
          type: "delete_file",
          path: file,
          reason: `timeline raw ${name} older than ${ttl} day(s); summary retained`,
          bytes,
          risk: "medium",
          category: "timeline",
        });
      }
    }
  }
}

/** 估算 scheduler journal 压紧后体积（每 trigger 仅保留最终 upsert）。 */
function estimateCompactSchedulerJournalBytes(lines: string[]): number {
  const triggers = new Map<string, string>();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as {
        op?: string;
        id?: string;
        trigger?: { id?: string };
      };
      if (parsed.op === "delete" && typeof parsed.id === "string") {
        triggers.delete(parsed.id);
        continue;
      }
      if (parsed.op === "upsert" && parsed.trigger?.id) {
        triggers.set(parsed.trigger.id, line);
      }
    } catch {
      continue;
    }
  }
  let bytes = 0;
  for (const line of triggers.values()) {
    bytes += Buffer.byteLength(line, "utf-8") + 1;
  }
  return bytes;
}

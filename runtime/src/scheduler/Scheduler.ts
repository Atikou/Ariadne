import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { Cron } from "croner";

import { evaluateOutputRules } from "../background/outputMatcher.js";
import type { BackgroundTaskRecord } from "../background/types.js";
import type { NotificationQueue } from "../background/NotificationQueue.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import { FileWatchHub, matchFilePattern, type FileWatchEvent } from "./FileWatchHub.js";
import { GitStatusHub, type GitStatusSnapshot } from "./GitStatusHub.js";
import type { CronMissPolicy } from "./types.js";
import {
  CreateTriggerInputSchema,
  type CreateTriggerInput,
  type MissPolicy,
  type SchedulerTransitionAction,
  type TriggerJournalLine,
  type TriggerRecord,
  TriggerJournalLineSchema,
  TriggerRecordSchema,
  type TriggerTransitionResult,
} from "./types.js";

type TimerHandle = { stop: () => void };
type OnceTriggerRecord = Extract<TriggerRecord, { kind: "once" }>;
type IntervalTriggerRecord = Extract<TriggerRecord, { kind: "interval" }>;
type CronTriggerRecord = Extract<TriggerRecord, { kind: "cron" }>;
type FileChangedTriggerRecord = Extract<
  TriggerRecord,
  { kind: "event"; eventType: "file_changed" }
>;

export interface TriggerFireContext {
  triggerId: string;
  goal: string;
  unattended: boolean;
  sessionId?: string;
}

export interface SchedulerOptions {
  workspaceRoot?: string;
  unattendedGoalPatterns?: string[];
  gitPollIntervalMs?: number;
  defaultCronMissPolicy?: CronMissPolicy;
  /** 触发后回调：由 Orchestrator 创建 Run / 无人值守时自动执行。 */
  onFire?: (ctx: TriggerFireContext) => { runId?: string } | void;
}

interface FireContext {
  filePath?: string;
  fileEvent?: FileWatchEvent["kind"];
  gitBranch?: string;
  gitDirty?: boolean;
}

/**
 * 触发器调度器（M8）。
 * 触发后仅向通知队列写入待办描述，不绕过权限直接执行工具。
 */
export class Scheduler {
  private readonly triggers = new Map<string, TriggerRecord>();
  private readonly timers = new Map<string, TimerHandle>();
  private readonly watchUnsubs = new Map<string, () => void>();
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly firing = new Set<string>();
  private readonly fileWatchHub?: FileWatchHub;
  private readonly workspaceRoot?: string;
  private readonly unattendedGoalPatterns: string[];
  private readonly gitPollIntervalMs: number;
  private readonly defaultCronMissPolicy: CronMissPolicy;
  private gitHub?: GitStatusHub;
  private readonly lastFireKeys = new Map<string, string>();
  private onFire?: (ctx: TriggerFireContext) => { runId?: string } | void;
  private started = false;

  constructor(
    private readonly journalFile: string,
    private readonly notifications: NotificationQueue,
    private readonly trace?: TraceLogger,
    options?: SchedulerOptions,
  ) {
    mkdirSync(path.dirname(journalFile), { recursive: true });
    this.workspaceRoot = options?.workspaceRoot;
    this.unattendedGoalPatterns = options?.unattendedGoalPatterns ?? [];
    this.gitPollIntervalMs = options?.gitPollIntervalMs ?? 5000;
    this.defaultCronMissPolicy = options?.defaultCronMissPolicy ?? "skip";
    this.onFire = options?.onFire;
    if (options?.workspaceRoot) {
      this.fileWatchHub = new FileWatchHub(options.workspaceRoot);
    }
    this.replay();
  }

  setFireHandler(fn: (ctx: TriggerFireContext) => { runId?: string } | void): void {
    this.onFire = fn;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const trigger of this.triggers.values()) {
      if (trigger.status === "active") {
        try {
          this.assertArmable(trigger);
          this.arm(trigger);
        } catch {
          this.pauseUnarmableTrigger(trigger);
        }
      }
    }
    this.refreshGitPolling();
  }

  stop(): void {
    this.started = false;
    for (const handle of this.timers.values()) {
      handle.stop();
    }
    this.timers.clear();
    for (const unsub of this.watchUnsubs.values()) {
      unsub();
    }
    this.watchUnsubs.clear();
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.fileWatchHub?.closeAll();
    this.gitHub?.stop();
  }

  list(): TriggerRecord[] {
    return [...this.triggers.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(snapshotTrigger);
  }

  get(id: string): TriggerRecord | undefined {
    const t = this.triggers.get(id);
    return t ? snapshotTrigger(t) : undefined;
  }

  register(raw: CreateTriggerInput): TriggerRecord {
    const parsed = CreateTriggerInputSchema.parse(raw);
    const now = new Date().toISOString();
    const trigger = createTriggerRecord(parsed, now);
    this.assertArmable(trigger);
    this.persist(trigger);
    if (this.started) {
      this.arm(trigger);
      this.refreshGitPolling();
    }
    this.trace?.write({ type: "scheduler_register", triggerId: trigger.id, kind: trigger.kind });
    return snapshotTrigger(trigger);
  }

  pause(id: string): TriggerTransitionResult {
    return this.transition(id, "pause");
  }

  resume(id: string): TriggerTransitionResult {
    return this.transition(id, "resume");
  }

  cancel(id: string): TriggerTransitionResult {
    return this.transition(id, "cancel");
  }

  /** M8：后台任务完成时匹配 event 触发器。 */
  handleBackgroundCompleted(record: BackgroundTaskRecord): void {
    for (const trigger of this.triggers.values()) {
      if (trigger.status !== "active" || trigger.kind !== "event") continue;
      if (trigger.eventType !== "background_completed") continue;
      const wantStatus = trigger.eventFilter?.status;
      if (wantStatus && wantStatus !== record.status) continue;
      const pattern = trigger.eventFilter?.outputPattern;
      if (pattern) {
        const results = evaluateOutputRules(record, [
          {
            name: "scheduler_filter",
            pattern,
            regex: trigger.eventFilter?.outputRegex,
            ignoreCase: trigger.eventFilter?.outputIgnoreCase,
            stream: trigger.eventFilter?.outputStream ?? "both",
          },
        ]);
        if (!results[0]?.matched) continue;
      }
      this.fire(trigger);
    }
  }

  /** M8：Git 状态变化时匹配 git_changed 触发器。 */
  handleGitChanged(snap: GitStatusSnapshot): void {
    for (const trigger of this.triggers.values()) {
      if (trigger.status !== "active" || trigger.kind !== "event") continue;
      if (trigger.eventType !== "git_changed") continue;
      if (trigger.eventFilter?.dirtyOnly && !snap.dirty) continue;
      if (trigger.eventFilter?.branch && trigger.eventFilter.branch !== snap.branch) continue;
      this.fire(trigger, { gitBranch: snap.branch, gitDirty: snap.dirty });
    }
  }

  /** M8：文件变更时匹配 file_changed 触发器（也可用于单测）。 */
  handleFileChanged(event: FileWatchEvent): void {
    for (const trigger of this.triggers.values()) {
      if (trigger.status !== "active" || trigger.kind !== "event") continue;
      if (trigger.eventType !== "file_changed") continue;
      const watchPath = (trigger.eventFilter?.watchPath ?? ".").replace(/\\/g, "/");
      const rel = event.relativePath.replace(/\\/g, "/");
      if (!pathMatchesWatch(rel, watchPath)) continue;
      if (!matchFilePattern(rel, trigger.eventFilter?.pattern)) continue;
      const debounceMs = trigger.eventFilter?.debounceMs ?? 300;
      this.scheduleDebouncedFire(trigger.id, debounceMs, {
        filePath: rel,
        fileEvent: event.kind,
      });
    }
  }

  private arm(trigger: TriggerRecord): void {
    this.disarm(trigger.id);
    if (trigger.kind === "event") {
      if (trigger.eventType === "file_changed") {
        this.armFileWatch(trigger);
      }
      if (trigger.eventType === "git_changed") {
        this.refreshGitPolling();
      }
      return;
    }

    if (trigger.kind === "once") {
      this.armOnce(trigger);
      return;
    }
    if (trigger.kind === "interval") {
      this.armInterval(trigger);
      return;
    }
    if (trigger.kind === "cron") {
      this.armCron(trigger);
    }
  }

  private assertArmable(trigger: TriggerRecord): void {
    if (trigger.kind === "event" && trigger.eventType === "file_changed") {
      this.fileWatchHub?.validateWatchPath(trigger.eventFilter?.watchPath ?? ".");
    }
  }

  private transition(id: string, action: SchedulerTransitionAction): TriggerTransitionResult {
    const current = this.triggers.get(id);
    if (!current) return { kind: "not_found" };

    if (
      current.status === "completed"
      || (current.status === "cancelled" && action !== "cancel")
    ) {
      return { kind: "conflict", trigger: snapshotTrigger(current) };
    }

    const nextStatus = action === "pause"
      ? "paused"
      : action === "resume"
        ? "active"
        : "cancelled";
    if (current.status === nextStatus) {
      return { kind: "updated", trigger: snapshotTrigger(current) };
    }
    if (action === "resume") this.assertArmable(current);

    const next = TriggerRecordSchema.parse({
      ...current,
      status: nextStatus,
      updatedAt: new Date().toISOString(),
    });
    if (action !== "resume") this.disarm(id);
    this.persist(next);
    if (action === "resume" && this.started) this.arm(next);
    this.refreshGitPolling();
    this.trace?.write({
      type: "scheduler_transition",
      triggerId: id,
      action,
      fromStatus: current.status,
      toStatus: next.status,
    });
    return { kind: "updated", trigger: snapshotTrigger(next) };
  }

  private pauseUnarmableTrigger(trigger: TriggerRecord): void {
    this.disarm(trigger.id);
    const paused = TriggerRecordSchema.parse({
      ...trigger,
      status: "paused",
      updatedAt: new Date().toISOString(),
    });
    this.persist(paused);
    this.notifications.enqueue({
      source: "scheduler",
      level: "warn",
      priority: "high",
      dedupeKey: `scheduler:arm-failed:${trigger.id}`,
      message: `调度触发器「${trigger.name}」无法恢复，已自动暂停`,
      payload: {
        triggerId: trigger.id,
        kind: trigger.kind,
        ...(trigger.kind === "event" ? { eventType: trigger.eventType } : {}),
      },
    });
    this.trace?.write({
      type: "scheduler_arm_failed",
      triggerId: trigger.id,
      kind: trigger.kind,
      recovery: "paused",
    });
  }

  private armFileWatch(trigger: FileChangedTriggerRecord): void {
    if (!this.fileWatchHub) return;
    const watchPath = trigger.eventFilter?.watchPath ?? ".";
    const pattern = trigger.eventFilter?.pattern;
    const debounceMs = trigger.eventFilter?.debounceMs ?? 300;
    const unsub = this.fileWatchHub.subscribe(watchPath, (event) => {
      const rel = event.relativePath.replace(/\\/g, "/");
      if (!pathMatchesWatch(rel, watchPath)) return;
      if (!matchFilePattern(rel, pattern)) return;
      this.scheduleDebouncedFire(trigger.id, debounceMs, {
        filePath: rel,
        fileEvent: event.kind,
      });
    });
    this.watchUnsubs.set(trigger.id, unsub);
  }

  private scheduleDebouncedFire(triggerId: string, debounceMs: number, ctx: FireContext): void {
    const existing = this.debounceTimers.get(triggerId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(triggerId);
      const trigger = this.triggers.get(triggerId);
      if (trigger) this.fire(trigger, ctx);
    }, debounceMs);
    this.debounceTimers.set(triggerId, timer);
  }

  private armOnce(trigger: OnceTriggerRecord): void {
    const atMs = Date.parse(trigger.at ?? "");
    if (!Number.isFinite(atMs)) return;
    const delay = atMs - Date.now();
    if (delay <= 0) {
      this.handleMissedOnce(trigger);
      return;
    }
    const timer = setTimeout(() => {
      this.fire(trigger);
    }, delay);
    this.timers.set(trigger.id, {
      stop: () => clearTimeout(timer),
    });
  }

  private handleMissedOnce(trigger: OnceTriggerRecord): void {
    const policy: MissPolicy = trigger.missPolicy ?? "skip";
    if (policy === "run_once") {
      this.fire(trigger);
      return;
    }
    trigger.status = "completed";
    trigger.updatedAt = new Date().toISOString();
    this.persist(trigger);
  }

  private armInterval(trigger: IntervalTriggerRecord): void {
    const ms = trigger.intervalMs ?? 0;
    if (ms <= 0) return;
    const timer = setInterval(() => {
      this.fire(trigger);
    }, ms);
    this.timers.set(trigger.id, {
      stop: () => clearInterval(timer),
    });
  }

  private armCron(trigger: CronTriggerRecord): void {
    const expr = trigger.cron ?? "";
    if (!expr) return;
    const job = new Cron(expr, { timezone: trigger.timezone, protect: true }, () => {
      this.fire(trigger);
    });
    this.timers.set(trigger.id, {
      stop: () => job.stop(),
    });
    const miss = trigger.cronMissPolicy ?? this.defaultCronMissPolicy;
    if (miss === "run_once" && trigger.fireCount === 0) {
      setTimeout(() => this.fire(trigger), 0);
    }
  }

  private refreshGitPolling(): void {
    const needsGit = [...this.triggers.values()].some(
      (t) => t.status === "active" && t.kind === "event" && t.eventType === "git_changed",
    );
    if (!needsGit || !this.workspaceRoot) {
      this.gitHub?.stop();
      return;
    }
    if (!this.gitHub) this.gitHub = new GitStatusHub();
    this.gitHub.start(this.workspaceRoot, this.gitPollIntervalMs, (snap) => {
      this.handleGitChanged(snap);
    });
  }

  private isUnattended(goal: string): boolean {
    if (this.unattendedGoalPatterns.length === 0) return false;
    return this.unattendedGoalPatterns.some((p) => p === "*" || goal.includes(p));
  }

  private fire(trigger: TriggerRecord, ctx?: FireContext): void {
    if (trigger.status !== "active") return;
    if (this.firing.has(trigger.id)) return;

    const dedupeKey = `${ctx?.filePath ?? ""}|${ctx?.gitBranch ?? ""}|${String(ctx?.gitDirty ?? "")}`;
    if (dedupeKey !== "||" && this.lastFireKeys.get(trigger.id) === dedupeKey && trigger.lastFiredAt) {
      const since = Date.now() - Date.parse(trigger.lastFiredAt);
      if (since < 1500) return;
    }
    if (dedupeKey !== "||") this.lastFireKeys.set(trigger.id, dedupeKey);

    const minGapMs =
      trigger.kind === "interval" && trigger.intervalMs ? Math.floor(trigger.intervalMs * 0.5) : 0;
    if (minGapMs > 0 && trigger.lastFiredAt) {
      const since = Date.now() - Date.parse(trigger.lastFiredAt);
      if (since < minGapMs) return;
    }

    this.firing.add(trigger.id);
    try {
      const now = new Date().toISOString();
      trigger.lastFiredAt = now;
      trigger.fireCount += 1;
      trigger.updatedAt = now;

      const fileHint = ctx?.filePath ? `（文件 ${ctx.filePath}）` : "";
      const gitHint =
        ctx?.gitBranch !== undefined
          ? `（分支 ${ctx.gitBranch}${ctx.gitDirty ? " 有未提交变更" : ""}）`
          : "";
      const unattended = this.isUnattended(trigger.goal);
      const fired = this.onFire?.({
        triggerId: trigger.id,
        goal: trigger.goal,
        unattended,
      });
      const runId = fired?.runId;
      this.notifications.enqueue({
        source: "scheduler",
        level: "info",
        priority: unattended ? "normal" : "high",
        runId,
        dedupeKey:
          dedupeKey !== "||"
            ? `scheduler:${trigger.id}:${dedupeKey}`
            : `scheduler:${trigger.id}:${trigger.fireCount}`,
        mergeKey: `scheduler:${trigger.id}`,
        message: `定时触发「${trigger.name}」：${trigger.goal}${fileHint}${gitHint}`,
        payload: {
          runId,
          triggerId: trigger.id,
          kind: trigger.kind,
          eventType: trigger.kind === "event" ? trigger.eventType : undefined,
          goal: trigger.goal,
          requiresConfirmation: !unattended,
          unattended,
          filePath: ctx?.filePath,
          fileEvent: ctx?.fileEvent,
          gitBranch: ctx?.gitBranch,
          gitDirty: ctx?.gitDirty,
        },
      });
      this.trace?.write({
        type: "scheduler_fire",
        triggerId: trigger.id,
        kind: trigger.kind,
        goal: trigger.goal,
        filePath: ctx?.filePath,
        unattended,
      });

      if (trigger.kind === "once") {
        trigger.status = "completed";
        this.disarm(trigger.id);
      }
      this.persist(trigger);
    } finally {
      this.firing.delete(trigger.id);
    }
  }

  private disarm(id: string): void {
    const handle = this.timers.get(id);
    if (handle) {
      handle.stop();
      this.timers.delete(id);
    }
    const unsub = this.watchUnsubs.get(id);
    if (unsub) {
      unsub();
      this.watchUnsubs.delete(id);
    }
    const debounce = this.debounceTimers.get(id);
    if (debounce) {
      clearTimeout(debounce);
      this.debounceTimers.delete(id);
    }
  }

  private persist(trigger: TriggerRecord): void {
    TriggerRecordSchema.parse(trigger);
    this.triggers.set(trigger.id, trigger);
    this.appendJournal({ op: "upsert", time: trigger.updatedAt, trigger: { ...trigger } });
  }

  private appendJournal(line: TriggerJournalLine): void {
    const parsed = TriggerJournalLineSchema.parse(line);
    appendFileSync(this.journalFile, `${JSON.stringify(parsed)}\n`, "utf-8");
  }

  private replay(): void {
    if (!existsSync(this.journalFile)) return;
    const text = readFileSync(this.journalFile, "utf-8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let decoded: unknown;
      try {
        decoded = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const result = TriggerJournalLineSchema.safeParse(decoded);
      if (!result.success) continue;
      const parsed = result.data;
      if (parsed.op === "delete") {
        this.triggers.delete(parsed.id);
        continue;
      }
      if (parsed.op === "upsert") {
        this.triggers.set(parsed.trigger.id, parsed.trigger);
      }
    }
  }
}

function createTriggerRecord(input: CreateTriggerInput, now: string): TriggerRecord {
  const base = {
    id: randomUUID(),
    name: input.name,
    status: "active" as const,
    goal: input.goal,
    createdAt: now,
    updatedAt: now,
    fireCount: 0,
  };
  switch (input.kind) {
    case "once":
      return TriggerRecordSchema.parse({
        ...base,
        kind: input.kind,
        at: input.at,
        missPolicy: input.missPolicy ?? "skip",
      });
    case "interval":
      return TriggerRecordSchema.parse({
        ...base,
        kind: input.kind,
        intervalMs: input.intervalMs,
      });
    case "cron":
      return TriggerRecordSchema.parse({
        ...base,
        kind: input.kind,
        cron: input.cron,
        timezone: input.timezone,
        cronMissPolicy: input.cronMissPolicy,
      });
    case "event": {
      const eventFilter = input.eventType === "file_changed"
        ? { watchPath: ".", ...input.eventFilter }
        : input.eventFilter;
      return TriggerRecordSchema.parse({
        ...base,
        kind: input.kind,
        eventType: input.eventType,
        eventFilter,
      });
    }
  }
}

function snapshotTrigger(trigger: TriggerRecord): TriggerRecord {
  return TriggerRecordSchema.parse(trigger);
}

function pathMatchesWatch(relativePath: string, watchPath: string): boolean {
  const normWatch = watchPath.replace(/\\/g, "/").replace(/\/$/, "") || ".";
  if (normWatch === ".") return true;
  return relativePath === normWatch || relativePath.startsWith(`${normWatch}/`);
}

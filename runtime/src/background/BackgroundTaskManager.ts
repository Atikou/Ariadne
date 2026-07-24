import { randomUUID } from "node:crypto";
import type { SandboxExecutionResult } from "../sandbox/SandboxContracts.js";
import type { ProcessSandbox, SandboxProcessHandle } from "../sandbox/ProcessSandbox.js";
import { resolveInsideWorkspace } from "../tools/pathSafe.js";
import { assertShellCommandStaysInWorkspace } from "../tools/shellTool.js";
import { PROCESS_CONTRACT } from "../tools/contractProfiles.js";
import type { ToolContract } from "../tools/types.js";
import { assertBackgroundCommandAllowed, type ShellPolicy } from "../policy/ShellPolicy.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import type { NotificationQueue } from "./NotificationQueue.js";
import {
  evaluateOutputRules,
  matchRuleOnStream,
  shouldTriggerOnMatch,
  type OutputMatchResult,
} from "./outputMatcher.js";
import {
  BackgroundStartInitialRequestSchema,
  BackgroundTaskRecordSchema,
} from "./BackgroundTaskContracts.js";
import {
  MAX_BACKGROUND_TASK_TIMEOUT_MS,
} from "./constants.js";
import type { BackgroundStartOptions, BackgroundTaskRecord } from "./types.js";

export interface BackgroundTriggerNextInput {
  record: BackgroundTaskRecord;
  matches: OutputMatchResult[];
  goal: string;
  phase: "stream" | "complete";
}

const MAX_OUTPUT_BYTES = 512 * 1024;

/** 在后台启动长时间命令，记录输出，完成后写入通知队列。 */
export class BackgroundTaskManager {
  readonly startTool: ToolContract<
    typeof BackgroundStartInitialRequestSchema,
    BackgroundTaskRecord
  >;
  private readonly tasks = new Map<string, BackgroundTaskRecord>();
  private readonly processes = new Map<string, SandboxProcessHandle>();
  private readonly cancelling = new Set<string>();
  private readonly streamFiredRules = new Map<string, Set<string>>();
  private readonly streamTriggeredGoals = new Set<string>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly notifications: NotificationQueue,
    private readonly processSandbox: ProcessSandbox,
    private readonly trace?: TraceLogger,
    private readonly onTaskDone?: (record: BackgroundTaskRecord) => void,
    private readonly onTriggerNext?: (input: BackgroundTriggerNextInput) => void,
    private readonly shellPolicy?: ShellPolicy,
  ) {
    this.startTool = {
      ...PROCESS_CONTRACT,
      name: "background_shell_start",
      description: "经授权后在指定工作区启动后台 Shell 任务，并持续记录输出与结束状态。",
      resolvePermissions: (input) =>
        (input as { networkAccess?: boolean }).networkAccess
          ? ["shell", "network"]
          : ["shell"],
      inputSchema: BackgroundStartInitialRequestSchema,
      outputSchema: BackgroundTaskRecordSchema,
      execute: async (input, context) =>
        this.startProcess(input.command, {
          cwd: input.cwd,
          networkAccess: input.networkAccess,
          timeoutMs: input.timeoutMs,
          outputRules: input.outputRules,
          triggerOnMatch: input.triggerOnMatch,
        }, {
          workspaceRoot: context.workspaceRoot || this.workspaceRoot,
          toolCallId: context.toolCallId,
          runId: context.requestId,
          sessionId: context.sessionId,
        }),
    };
  }

  private startProcess(
    command: string,
    options: BackgroundStartOptions | undefined,
    execution: {
      workspaceRoot: string;
      toolCallId?: string;
      runId?: string;
      sessionId?: string;
    },
  ): BackgroundTaskRecord {
    const trimmed = command.trim();
    if (!trimmed) throw new Error("command 不能为空");

    if (this.shellPolicy) {
      this.shellPolicy.assertAllowed(trimmed, "后台命令被策略拒绝");
    } else {
      assertBackgroundCommandAllowed(trimmed);
    }
    assertShellCommandStaysInWorkspace(trimmed);

    const cwd = options?.cwd;
    const timeoutMs = options?.timeoutMs;
    const resolvedCwd = cwd
      ? resolveInsideWorkspace(execution.workspaceRoot, cwd)
      : execution.workspaceRoot;
    const id = randomUUID();
    const record: BackgroundTaskRecord = {
      id,
      command: trimmed,
      cwd: resolvedCwd,
      timeoutMs,
      networkAccess: options?.networkAccess ?? false,
      status: "running",
      stdout: "",
      stderr: "",
      startedAt: new Date().toISOString(),
      outputRules: options?.outputRules,
      triggerOnMatch: options?.triggerOnMatch,
      outputMatches: [],
      toolCallId: execution.toolCallId,
      runId: execution.runId,
      sessionId: execution.sessionId,
    };
    this.streamFiredRules.set(id, new Set());
    this.tasks.set(id, record);
    this.trace?.write({
      type: "background_start",
      taskId: id,
      command: trimmed,
      toolCallId: execution.toolCallId,
      runId: execution.runId,
      sessionId: execution.sessionId,
    });

    try {
      const handle = this.processSandbox.startShell(
        {
          command: trimmed,
          cwd: resolvedCwd,
          workspaceRoot: execution.workspaceRoot,
          networkMode: options?.networkAccess ? "online-approved" : "offline",
          timeoutMs: timeoutMs ?? MAX_BACKGROUND_TASK_TIMEOUT_MS,
          maxOutputBytes: MAX_OUTPUT_BYTES,
        },
        {
          onStarted: ({ pid }) => {
            if (pid) record.pid = pid;
          },
          onStdout: (chunk) => {
            appendOutput(record, "stdout", chunk);
            this.checkStreamRules(record);
          },
          onStderr: (chunk) => {
            appendOutput(record, "stderr", chunk);
            this.checkStreamRules(record);
          },
        },
      );
      this.processes.set(id, handle);
      void handle.completion.then(
        (result) => this.completeProcess(id, result),
        (error) => this.failProcess(id, error),
      );
    } catch (error) {
      this.failProcess(id, error);
    }

    return this.snapshot(record);
  }

  get(id: string): BackgroundTaskRecord | undefined {
    const task = this.tasks.get(id);
    return task ? this.snapshot(task) : undefined;
  }

  list(): BackgroundTaskRecord[] {
    return [...this.tasks.values()].map((t) => this.snapshot(t));
  }

  markTriggeredRun(id: string, runId: string): void {
    const task = this.tasks.get(id);
    if (task) task.triggeredRunId = runId;
  }

  cancel(id: string): BackgroundTaskRecord | undefined {
    const task = this.tasks.get(id);
    const proc = this.processes.get(id);
    if (!task || !proc) return undefined;
    if (task.status !== "running") return this.snapshot(task);

    this.cancelling.add(id);
    proc.cancel();
    this.scheduleForcedFinalize(id, "cancelled");
    return this.snapshot(task);
  }

  async shutdown(timeoutMs = 5_000): Promise<void> {
    for (const task of this.tasks.values()) {
      if (task.status === "running") this.cancel(task.id);
    }
    const deadline = Date.now() + timeoutMs;
    while ([...this.tasks.values()].some((task) => task.status === "running")) {
      if (Date.now() >= deadline) {
        for (const task of this.tasks.values()) {
          if (task.status === "running") {
            this.forceFinalizeIfRunning(task.id, "cancelled", "应用关闭时强制终止后台任务");
          }
        }
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }

  private completeProcess(id: string, result: SandboxExecutionResult): void {
    const record = this.tasks.get(id);
    if (!record || record.status !== "running") return;
    this.processes.delete(id);
    record.endedAt = new Date().toISOString();
    record.exitCode = result.exitCode ?? null;
    if (!record.stdout && result.stdout) appendOutput(record, "stdout", Buffer.from(result.stdout));
    if (!record.stderr && result.stderr) appendOutput(record, "stderr", Buffer.from(result.stderr));

    const wasCancelled = this.cancelling.delete(id);
    if (result.timedOut) {
      record.status = "timed_out";
      record.error = `执行超时（${record.timeoutMs ?? MAX_BACKGROUND_TASK_TIMEOUT_MS}ms）`;
    } else if (wasCancelled || result.errorCode === "cancelled") {
      record.status = "cancelled";
    } else if (result.spawnFailed) {
      record.status = "failed";
      record.error = result.stderr || result.errorCode || "沙箱进程启动失败";
    } else if (result.exitCode === 0) {
      record.status = "completed";
    } else {
      record.status = "failed";
      record.error = result.stderr || `exitCode=${result.exitCode ?? "unknown"}`;
    }

    this.enqueueDone(record);
    this.trace?.write({
      type: "background_done",
      taskId: id,
      status: record.status,
      exitCode: record.exitCode,
      sandboxErrorCode: result.errorCode,
      isolation: result.isolation,
      toolCallId: record.toolCallId,
      runId: record.runId,
    });
  }

  private failProcess(id: string, error: unknown): void {
    const record = this.tasks.get(id);
    if (!record || record.status !== "running") return;
    this.processes.delete(id);
    this.cancelling.delete(id);
    record.status = "failed";
    record.error = String(error);
    record.endedAt = new Date().toISOString();
    this.enqueueDone(record);
  }

  private scheduleForcedFinalize(
    id: string,
    status: Extract<BackgroundTaskRecord["status"], "cancelled" | "timed_out">,
    error?: string,
  ): void {
    setTimeout(() => {
      this.forceFinalizeIfRunning(id, status, error);
    }, 1_000).unref?.();
  }

  private forceFinalizeIfRunning(
    id: string,
    status: Extract<BackgroundTaskRecord["status"], "cancelled" | "timed_out">,
    error?: string,
  ): void {
    const record = this.tasks.get(id);
    if (!record || record.status !== "running") return;
    this.processes.delete(id);
    this.cancelling.delete(id);
    record.status = status;
    if (error) record.error = error;
    record.endedAt = new Date().toISOString();
    this.enqueueDone(record);
    this.trace?.write({
      type: "background_done",
      taskId: id,
      status: record.status,
      exitCode: record.exitCode,
      signal: status === "cancelled" ? "SIGTERM" : "SIGKILL",
      forcedFinalize: true,
    });
  }

  private enqueueDone(record: BackgroundTaskRecord): void {
    const rules = record.outputRules ?? [];
    if (rules.length > 0) {
      const evaluated = evaluateOutputRules(record, rules);
      const prior = record.outputMatches ?? [];
      const merged = mergeMatchResults(prior, evaluated);
      record.outputMatches = merged;
    }

    const trigger = record.triggerOnMatch;
    if (
      trigger &&
      rules.length > 0 &&
      record.outputMatches &&
      shouldTriggerOnMatch(record, rules, record.outputMatches, trigger)
    ) {
      this.fireTriggerNext(record, record.outputMatches, trigger.goal, "complete");
    }

    const level =
      record.status === "completed"
        ? "info"
        : record.status === "cancelled" || record.status === "timed_out"
          ? "warn"
          : "error";
    const matchedNames = (record.outputMatches ?? []).filter((m) => m.matched).map((m) => m.name);
    this.notifications.enqueue({
      source: "background_task",
      level,
      message: `后台任务「${record.command}」已${statusLabel(record.status)}（退出码 ${record.exitCode ?? "—"}）`,
      taskId: record.id,
      payload: {
        command: record.command,
        status: record.status,
        exitCode: record.exitCode,
        stdoutTail: tail(record.stdout),
        stderrTail: tail(record.stderr),
        outputMatches: record.outputMatches,
        matchedRules: matchedNames,
        triggeredRunId: record.triggeredRunId,
        runId: record.runId,
        toolCallId: record.toolCallId,
      },
    });
    this.streamFiredRules.delete(record.id);
    this.onTaskDone?.(record);
  }

  private checkStreamRules(record: BackgroundTaskRecord): void {
    const rules = record.outputRules ?? [];
    if (rules.length === 0) return;
    const fired = this.streamFiredRules.get(record.id) ?? new Set<string>();
    for (const rule of rules) {
      if (!rule.fireOnStream || fired.has(rule.name)) continue;
      const hit = matchRuleOnStream(record, rule);
      if (!hit) continue;
      fired.add(rule.name);
      record.outputMatches = mergeMatchResults(record.outputMatches ?? [], [hit]);
      this.notifications.enqueue({
        source: "background_task",
        level: "info",
        message: `后台任务「${record.command}」输出命中规则：${rule.name}`,
        taskId: record.id,
        dedupeKey: `bg-stream:${record.id}:${rule.name}`,
        payload: {
          command: record.command,
          outputMatch: hit,
          phase: "stream",
        },
      });
      const trigger = record.triggerOnMatch;
      if (trigger?.goal && trigger.requireSuccess === false) {
        this.fireTriggerNext(record, [hit], trigger.goal, "stream");
      }
    }
    this.streamFiredRules.set(record.id, fired);
  }

  private fireTriggerNext(
    record: BackgroundTaskRecord,
    matches: OutputMatchResult[],
    goal: string,
    phase: BackgroundTriggerNextInput["phase"],
  ): void {
    if (record.triggeredRunId) return;
    const key = `${record.id}:${goal}`;
    if (phase === "stream" && this.streamTriggeredGoals.has(key)) return;
    if (phase === "stream") this.streamTriggeredGoals.add(key);
    this.onTriggerNext?.({ record, matches, goal, phase });
    this.trace?.write({
      type: "background_trigger_next",
      taskId: record.id,
      goal,
      phase,
      matches: matches.filter((m) => m.matched).map((m) => m.name),
    });
  }

  private snapshot(task: BackgroundTaskRecord): BackgroundTaskRecord {
    return BackgroundTaskRecordSchema.parse(task);
  }
}

function appendOutput(task: BackgroundTaskRecord, stream: "stdout" | "stderr", chunk: Buffer): void {
  const text = chunk.toString("utf-8");
  const current = stream === "stdout" ? task.stdout : task.stderr;
  const next = current + text;
  const trimmed = next.length > MAX_OUTPUT_BYTES ? next.slice(-MAX_OUTPUT_BYTES) : next;
  if (stream === "stdout") task.stdout = trimmed;
  else task.stderr = trimmed;
}

function mergeMatchResults(
  prior: OutputMatchResult[],
  next: OutputMatchResult[],
): OutputMatchResult[] {
  const byName = new Map(prior.map((p) => [p.name, p]));
  for (const item of next) {
    const existing = byName.get(item.name);
    byName.set(item.name, existing ? { ...existing, ...item, matched: existing.matched || item.matched } : item);
  }
  return [...byName.values()];
}

function tail(text: string, max = 500): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

function statusLabel(status: BackgroundTaskRecord["status"]): string {
  switch (status) {
    case "completed":
      return "完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "取消";
    case "timed_out":
      return "超时";
    default:
      return "结束";
  }
}

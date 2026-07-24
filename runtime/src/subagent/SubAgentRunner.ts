import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { AgentLoop, type LoopChatFn } from "../agent/AgentLoop.js";
import { resolveAgentRunOutcome } from "../agent/AgentRunOutcome.js";
import type { ToolPermission } from "../core/permissions.js";
import type { RunBudget } from "../agent/RunPolicyTypes.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import type { NotificationQueue } from "../background/NotificationQueue.js";
import { toModelSelection } from "./modelSelection.js";
import { enqueueSubAgentCompletionNotification } from "./notifyCompletion.js";
import { runLightweightTextTask, runSingleShotReview } from "./singleShot.js";
import { hasSuccessfulPreload, preloadReferencedFiles } from "./taskContext.js";
import { resolveSubagentTimeoutMs } from "./SubAgentRuntimePolicy.js";
import { isLightweightReadonlySubagentTask } from "./lightweightTask.js";
import type { DelegatedTask, NormalizedDelegatedTask } from "./delegatedTask.js";
import { limitsToRunBudget, normalizeDelegatedTask } from "./delegatedTask.js";
import { defaultContextRouter } from "./ContextRouter.js";
import { defaultResultCollector } from "./ResultCollector.js";
import { defaultToolRouter } from "./ToolRouter.js";
import { buildDelegatedTaskSystemPrompt } from "./taskPrompt.js";
import type {
  DelegatedTaskRunOptions,
  SubAgentAggregate,
  SubAgentConflict,
  SubAgentRunResult,
  SubAgentStatus,
  SubAgentWriteConflict,
} from "./types.js";
import { detectWriteConflicts } from "./writeConflictMerge.js";
import { assertWithinCostBudget, sumModelTurnCost } from "../util/costBudget.js";
import type { ProcessSandbox } from "../sandbox/ProcessSandbox.js";
import {
  type SubAgentWorkspaceManager,
  type SubAgentWorkspaceSession,
} from "./SubAgentWorkspaceManager.js";
import type { HookManager } from "../hooks/HookManager.js";

export interface SubAgentRunnerDeps {
  chat: LoopChatFn;
  createChatForDelegatedTask?: (
    task: DelegatedTask,
    ctx: {
      sensitive?: boolean;
      parentTaskId?: string;
      parentIntent?: string;
      parentWorkflowType?: string;
    },
  ) => LoopChatFn;
  registry: ToolRegistry;
  trace?: TraceLogger;
  projectAllowedPermissions?: ToolPermission[];
  notificationQueue?: NotificationQueue;
  maxSubAgentDispatchDepth?: number;
  maxBatchConcurrency?: number;
  workspaceManager?: SubAgentWorkspaceManager;
  defaultTimeoutMs?: number;
  hooks?: HookManager;
}

export class SubAgentRunner {
  constructor(private readonly deps: SubAgentRunnerDeps) {}

  async runDelegated(options: DelegatedTaskRunOptions): Promise<SubAgentRunResult> {
    const workspaceRoot = await realpath(options.workspaceRoot);
    const task = normalizeDelegatedTask(options.task);
    const id = task.id ?? randomUUID();
    const toolPolicy = task.toolPolicy;
    const { permissions: granted, allowedToolNames } = defaultToolRouter.resolvePermissions(
      toolPolicy,
      options.grantedPermissions,
      this.deps.projectAllowedPermissions,
    );
    const budget = limitsToRunBudget(task.limits, toolPolicy.writeAllowed);
    const timeoutMs = resolveSubagentTimeoutMs(
      options.timeoutMs ?? task.limits?.maxRuntimeMs,
      this.deps.defaultTimeoutMs,
    );
    const parentTaskId = options.parentTaskId;
    const start = performance.now();

    this.deps.trace?.write({
      type: "subagent_start",
      subAgentId: id,
      goal: task.goal,
      parentTaskId,
      grantedPermissions: granted,
      routingCapabilities: task.modelPolicy?.requiredCapabilities,
      executionMode: options.executionRoute?.mode ?? "delegate",
      executionReason: options.executionRoute?.reason,
    });

    const abortController = new AbortController();
    const propagateParentAbort = () => {
      if (!abortController.signal.aborted) {
        abortController.abort(options.signal?.reason ?? new Error("父 Agent 已取消"));
      }
    };
    if (options.signal?.aborted) propagateParentAbort();
    else options.signal?.addEventListener("abort", propagateParentAbort, { once: true });
    const timeout = setTimeout(() => {
      if (!abortController.signal.aborted) {
        abortController.abort(new Error(`子 Agent 执行超时（${timeoutMs}ms）`));
      }
    }, timeoutMs);
    const signal = abortController.signal;

    let workspaceSession: SubAgentWorkspaceSession | undefined;
    try {
      if (toolPolicy.writeAllowed) {
        try {
          if (!this.deps.workspaceManager) throw new Error("subagent_workspace_manager_not_configured");
          workspaceSession = await this.deps.workspaceManager.create(
            workspaceRoot,
            id,
          );
        } catch (error) {
          return this.finishRun({
            id,
            taskId: id,
            goal: task.goal,
            parentTaskId,
            status: "failed",
            answer: "（子 Agent 写隔离初始化失败，未触碰主工作区）",
            steps: [],
            iterations: 0,
            durationMs: Math.round(performance.now() - start),
            grantedPermissions: granted,
            error: String(error),
          });
        }
      }
      const result = await this.runInner({
        id,
        task,
        granted,
        allowedToolNames,
        timeoutMs,
        budget,
        parentTaskId,
        sensitive: options.sensitive,
        parentIntent: options.parentIntent,
        parentWorkflowType: options.parentWorkflowType,
        dispatchDepth: options.dispatchDepth,
        signal,
        start,
        executionRoute: options.executionRoute,
        maxCostUsd: options.maxCostUsd,
        workspaceRoot: workspaceSession?.workspaceRoot ?? workspaceRoot,
        processSandbox: workspaceSession?.processSandbox,
      });
      if (workspaceSession) {
        result.workspaceIsolation = await workspaceSession.collect();
      }
      return result;
    } finally {
      await workspaceSession?.dispose();
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", propagateParentAbort);
    }
  }

  private async runInner(input: {
    id: string;
    task: NormalizedDelegatedTask;
    granted: ToolPermission[];
    allowedToolNames: Set<string>;
    timeoutMs: number;
    budget: RunBudget;
    parentTaskId?: string;
    sensitive?: boolean;
    parentIntent?: string;
    parentWorkflowType?: string;
    dispatchDepth?: number;
    signal?: AbortSignal;
    start: number;
    executionRoute?: DelegatedTaskRunOptions["executionRoute"];
    maxCostUsd?: number;
    workspaceRoot: string;
    processSandbox?: ProcessSandbox;
  }): Promise<SubAgentRunResult> {
    const { id, task, granted, allowedToolNames, timeoutMs, budget, parentTaskId, sensitive, parentIntent, parentWorkflowType, dispatchDepth, signal, start, executionRoute, maxCostUsd, workspaceRoot, processSandbox } =
      input;

    const chatCapture: SubAgentChatCapture = { modelTurns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const chat = this.resolveChat(
      task,
      { sensitive, parentTaskId, parentIntent, parentWorkflowType, maxCostUsd },
      chatCapture,
    );

    const preloadText = [task.goal, task.input, ...(task.context?.files ?? [])].join("\n");
    const preloaded = allowedToolNames.has("read_file")
      ? await preloadReferencedFiles(preloadText, this.deps.registry, workspaceRoot)
      : "";

    const packaged = defaultContextRouter.package(task, executionRoute);

    if (!task.toolPolicy?.writeAllowed && hasSuccessfulPreload(preloaded)) {
      try {
        const answer = await raceTimeout(
          runSingleShotReview(task, packaged.userContent, preloaded, chat, { sensitive, signal }),
          timeoutMs,
          signal,
        );
        return this.finishRun({
          id,
          taskId: id,
          goal: task.goal,
          parentTaskId,
          status: "completed",
          answer,
          steps: [],
          iterations: 1,
          durationMs: Math.round(performance.now() - start),
          grantedPermissions: granted,
          routingMeta: chatCapture.routingMeta,
          usage: usageFromCapture(chatCapture),
          executionRoute: executionRoute ? { mode: executionRoute.mode, reason: executionRoute.reason } : undefined,
        });
      } catch (err) {
        if (isParentCancellation(signal, err)) {
          return this.finishCancelled(id, task.goal, granted, parentTaskId, start, err);
        }
      }
    }

    if (isLightweightReadonlySubagentTask(task)) {
      try {
        const answer = await raceTimeout(
          runLightweightTextTask(task, packaged.userContent, chat, { sensitive, signal }),
          timeoutMs,
          signal,
        );
        return this.finishRun({
          id,
          taskId: id,
          goal: task.goal,
          parentTaskId,
          status: "completed",
          answer,
          steps: [],
          iterations: 1,
          durationMs: Math.round(performance.now() - start),
          grantedPermissions: granted,
          routingMeta: chatCapture.routingMeta,
          usage: usageFromCapture(chatCapture),
          executionRoute: executionRoute ? { mode: executionRoute.mode, reason: executionRoute.reason } : undefined,
        });
      } catch (err) {
        if (isParentCancellation(signal, err)) {
          return this.finishCancelled(id, task.goal, granted, parentTaskId, start, err);
        }
        const msg = String(err);
        if (msg.includes("超时")) {
          const durationMs = Math.round(performance.now() - start);
          this.deps.trace?.write({
            type: "subagent_end",
            subAgentId: id,
            goal: task.goal,
            parentTaskId,
            status: "timeout",
            durationMs,
            iterations: 0,
          });
          return this.finishRun({
            id,
            taskId: id,
            goal: task.goal,
            parentTaskId,
            status: "timeout",
            answer: "（子 Agent 执行超时）",
            steps: [],
            iterations: 0,
            durationMs,
            grantedPermissions: granted,
            error: msg,
            routingMeta: chatCapture.routingMeta,
            usage: usageFromCapture(chatCapture),
            executionRoute: executionRoute ? { mode: executionRoute.mode, reason: executionRoute.reason } : undefined,
          });
        }
      }
    }

    const userContent = [packaged.userContent, preloaded ? preloaded : ""].filter(Boolean).join("\n\n");
    const systemExtra = buildDelegatedTaskSystemPrompt(task, budget, parentTaskId);
    const roleAllowed: ToolPermission[] = ["read"];
    if (task.toolPolicy?.writeAllowed) roleAllowed.push("write");
    if (task.toolPolicy?.shellAllowed) roleAllowed.push("shell");

    const loop = new AgentLoop({
      chat,
      registry: this.deps.registry,
      workspaceRoot,
      processSandbox,
      projectAllowedPermissions: this.deps.projectAllowedPermissions,
      roleAllowedPermissions: roleAllowed,
      allowedPermissions: granted,
      runGrantedPermissions: granted,
      allowedToolNames: [...allowedToolNames],
      budget,
      mode: task.toolPolicy?.writeAllowed || task.toolPolicy?.shellAllowed ? "implement" : "chat",
      permissionPolicy: task.toolPolicy?.shellAllowed
        ? "confirmBeforeRun"
        : task.toolPolicy?.writeAllowed
          ? "confirmBeforeEdit"
          : "readOnly",
      autoConfirm: false,
      sensitive,
      trace: this.deps.trace,
      subAgentDispatchDepth: dispatchDepth ?? 0,
      maxSubAgentDispatchDepth: this.deps.maxSubAgentDispatchDepth ?? 1,
      maxCostUsdPerRun: maxCostUsd,
      signal,
    });

    let status: SubAgentStatus = "completed";
    let answer = "";
    let steps: SubAgentRunResult["steps"] = [];
    let iterations = 0;
    let error: string | undefined;

    try {
      const result = await raceTimeout(loop.run(userContent, systemExtra), timeoutMs, signal);
      answer = result.answer;
      steps = result.steps;
      iterations = result.iterations;
      const outcome = resolveAgentRunOutcome(result.executionMeta.stopReason);
      if (outcome.runStatus !== "completed") {
        status = "failed";
        error = result.executionMeta.stopReason === "budget_exhausted"
          ? `达到子 Agent 运行预算（耗尽 ${result.executionMeta.budgetExhausted ?? "unknown"}）`
          : `子 Agent 未完成：${result.executionMeta.stopReason}`;
      }
    } catch (err) {
      if (
        isParentCancellation(signal, err)
      ) {
        return this.finishCancelled(id, task.goal, granted, parentTaskId, start, err);
      }
      const msg = String(err);
      status = msg.includes("超时") ? "timeout" : "failed";
      error = msg;
      answer = status === "timeout" ? "（子 Agent 执行超时）" : "（子 Agent 执行失败）";
      iterations = chatCapture.modelTurns;
    }

    const durationMs = Math.round(performance.now() - start);
    this.deps.trace?.write({
      type: "subagent_end",
      subAgentId: id,
      goal: task.goal,
      parentTaskId,
      status,
      durationMs,
      iterations,
      inputTokens: chatCapture.inputTokens || undefined,
      outputTokens: chatCapture.outputTokens || undefined,
      costUsd: chatCapture.costUsd || undefined,
    });

    return this.finishRun({
      id,
      taskId: id,
      goal: task.goal,
      parentTaskId,
      status,
      answer,
      steps,
      iterations,
      durationMs,
      grantedPermissions: granted,
      error,
      routingMeta: chatCapture.routingMeta,
      usage: usageFromCapture(chatCapture, steps.length),
      executionRoute: executionRoute ? { mode: executionRoute.mode, reason: executionRoute.reason } : undefined,
    });
  }

  private resolveChat(
    task: NormalizedDelegatedTask,
    ctx: {
      sensitive?: boolean;
      parentTaskId?: string;
      parentIntent?: string;
      parentWorkflowType?: string;
      maxCostUsd?: number;
    },
    capture?: SubAgentChatCapture,
  ): LoopChatFn {
    const base = this.deps.createChatForDelegatedTask?.(task, ctx) ?? this.deps.chat;
    return async (request, chatOpts) => {
      assertWithinCostBudget(capture?.costUsd ?? 0, ctx.maxCostUsd);
      const response = await base(request, {
        ...chatOpts,
        spentCostUsd: capture?.costUsd ?? chatOpts?.spentCostUsd,
        maxCostUsd: ctx.maxCostUsd ?? chatOpts?.maxCostUsd,
      });
      if (capture) {
        capture.modelTurns += 1;
        capture.inputTokens += response.usage?.inputTokens ?? 0;
        capture.outputTokens += response.usage?.outputTokens ?? 0;
        capture.costUsd = sumModelTurnCost([capture.costUsd, response.costUsd]);
        assertWithinCostBudget(capture.costUsd, ctx.maxCostUsd);
      }
      if (capture && !capture.routingMeta && response.routingMeta) {
        const decision = response.routingMeta.routerDecision;
        capture.routingMeta = {
          clientName: response.clientName,
          modelName: response.modelName,
          location: response.location,
          taskType: decision.taskType,
          reason: decision.reason,
        };
      }
      return response;
    };
  }

  private finishCancelled(
    id: string,
    goal: string,
    granted: ToolPermission[],
    parentTaskId: string | undefined,
    start: number,
    err: unknown,
  ): SubAgentRunResult {
    const durationMs = Math.round(performance.now() - start);
    const error = String(err);
    this.deps.trace?.write({
      type: "subagent_end",
      subAgentId: id,
      goal,
      parentTaskId,
      status: "cancelled",
      durationMs,
      iterations: 0,
    });
    return this.finishRun({
      id,
      taskId: id,
      goal,
      parentTaskId,
      status: "cancelled",
      answer: "（子 Agent 已取消）",
      steps: [],
      iterations: 0,
      durationMs,
      grantedPermissions: granted,
      error,
    });
  }

  private finishRun(result: SubAgentRunResult): SubAgentRunResult {
    const finalized: SubAgentRunResult = {
      ...result,
      modelUsed: result.modelUsed ?? toModelSelection(result.routingMeta),
      structured: defaultResultCollector.collect({
        taskId: result.taskId,
        status: result.status,
        rawAnswer: result.answer,
        steps: result.steps,
        modelUsed: result.modelUsed ?? toModelSelection(result.routingMeta),
        error: result.error,
      }),
    };
    if (this.deps.notificationQueue) {
      enqueueSubAgentCompletionNotification(this.deps.notificationQueue, {
        subAgentId: finalized.id,
        goal: finalized.goal,
        parentTaskId: finalized.parentTaskId,
        status: finalized.status,
        answer: finalized.structured?.summary ?? finalized.answer,
        error: finalized.error,
      });
    }
    return finalized;
  }
}

interface SubAgentChatCapture {
  routingMeta?: SubAgentRunResult["routingMeta"];
  modelTurns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

function usageFromCapture(
  capture: SubAgentChatCapture,
  toolCalls = 0,
): NonNullable<SubAgentRunResult["usage"]> {
  return {
    modelTurns: capture.modelTurns,
    toolCalls,
    inputTokens: capture.inputTokens || undefined,
    outputTokens: capture.outputTokens || undefined,
    costUsd: capture.costUsd || undefined,
  };
}

function isParentCancellation(signal: AbortSignal | undefined, error: unknown): boolean {
  if (!signal?.aborted) return false;
  return !String(signal.reason ?? error).includes("超时");
}

async function raceTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw signal.reason ?? new Error("子 Agent 已取消");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`子 Agent 执行超时（${timeoutMs}ms）`)), timeoutMs);
  });
  const abortRace = signal
    ? new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason ?? new Error("子 Agent 已取消"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      })
    : undefined;
  try {
    const racers: Array<Promise<T>> = [promise, timeout];
    if (abortRace) racers.push(abortRace);
    return await Promise.race(racers);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export function aggregateSubAgentResults(results: SubAgentRunResult[]): string {
  return aggregateSubAgentResultsStructured(results).mergedAnswer;
}

export function aggregateSubAgentResultsStructured(results: SubAgentRunResult[]): SubAgentAggregate {
  if (results.length === 0) {
    return {
      status: "failed",
      completed: 0,
      failed: 0,
      timedOut: 0,
      commonFindings: [],
      conflicts: [],
      writeConflicts: [],
      mergedAnswer: "（无子 Agent 结果）",
    };
  }
  const completed = results.filter((r) => r.status === "completed");
  const failed = results.filter((r) => r.status === "failed");
  const timedOut = results.filter((r) => r.status === "timeout");
  const cancelled = results.filter((r) => r.status === "cancelled");
  const commonFindings = findCommonFindings(completed);
  const conflicts = detectConflicts(completed);
  const writeConflicts = detectWriteConflicts(results);
  const status: SubAgentAggregate["status"] =
    conflicts.length > 0 || writeConflicts.length > 0
      ? "conflict"
      : completed.length === 0
        ? "failed"
        : failed.length > 0 || timedOut.length > 0 || cancelled.length > 0
          ? "partial"
          : "completed";
  const sections = [
    `子 Agent 汇总：${status}（完成 ${completed.length}/${results.length}，失败 ${failed.length}，超时 ${timedOut.length}，取消 ${cancelled.length}）`,
    commonFindings.length > 0
      ? `共同结论：\n${commonFindings.map((f) => `- ${f}`).join("\n")}`
      : "共同结论：未发现跨任务重复结论。",
    conflicts.length > 0
      ? `文本冲突：\n${conflicts.map(renderConflict).join("\n")}`
      : "文本冲突：未发现明显相反结论。",
    writeConflicts.length > 0
      ? `写入冲突：\n${writeConflicts.map(renderWriteConflict).join("\n")}`
      : "写入冲突：未发现多任务写入同一文件。",
    results
      .map((r) => {
        const head = `[${r.goal.slice(0, 40)}] ${r.status} · ${r.durationMs}ms`;
        const body = r.error ? `错误：${r.error}` : r.answer;
        return `${head}\n${body}`;
      })
      .join("\n\n---\n\n"),
  ];
  return {
    status,
    completed: completed.length,
    failed: failed.length,
    timedOut: timedOut.length,
    commonFindings,
    conflicts,
    writeConflicts,
    mergedAnswer: sections.join("\n\n"),
  };
}

function findCommonFindings(results: SubAgentRunResult[]): string[] {
  const byNormalized = new Map<string, { text: string; taskIds: Set<string> }>();
  for (const result of results) {
    for (const sentence of splitFindings(result.answer)) {
      const normalized = normalizeFinding(sentence);
      if (normalized.length < 6) continue;
      const existing = byNormalized.get(normalized) ?? { text: sentence, taskIds: new Set<string>() };
      existing.taskIds.add(result.taskId);
      byNormalized.set(normalized, existing);
    }
  }
  return [...byNormalized.values()]
    .filter((item) => item.taskIds.size >= 2)
    .map((item) => item.text)
    .slice(0, 8);
}

function detectConflicts(results: SubAgentRunResult[]): SubAgentConflict[] {
  const conflicts: SubAgentConflict[] = [];
  for (let i = 0; i < results.length; i += 1) {
    for (let j = i + 1; j < results.length; j += 1) {
      const pair = detectPairConflict(results[i]!, results[j]!);
      if (pair) conflicts.push(pair);
    }
  }
  return conflicts.slice(0, 10);
}

function detectPairConflict(left: SubAgentRunResult, right: SubAgentRunResult): SubAgentConflict | undefined {
  for (const l of splitFindings(left.answer)) {
    for (const r of splitFindings(right.answer)) {
      const topic = sharedTopic(l, r);
      if (!topic) continue;
      const lPolarity = findingPolarity(l);
      const rPolarity = findingPolarity(r);
      if (lPolarity === "neutral" || rPolarity === "neutral" || lPolarity === rPolarity) continue;
      return {
        topic,
        taskIds: [left.taskId, right.taskId],
        excerpts: [
          { taskId: left.taskId, goal: left.goal, text: l },
          { taskId: right.taskId, goal: right.goal, text: r },
        ],
        reason: "同一主题出现相反结论",
      };
    }
  }
  return undefined;
}

function splitFindings(answer: string): string[] {
  return answer
    .split(/\r?\n|[。；;]+/g)
    .map((line) => line.replace(/^[-*•\d.、\s]+/, "").trim())
    .filter((line) => line.length >= 4)
    .slice(0, 20);
}

function normalizeFinding(text: string): string {
  return text.toLowerCase().replace(/[`"'“”‘’\s，,。；;：:！!？?()[\]{}]/g, "");
}

function sharedTopic(left: string, right: string): string | undefined {
  const leftTokens = topicTokens(left);
  const rightTokens = topicTokens(right);
  return [...leftTokens].find((token) => rightTokens.has(token));
}

function topicTokens(text: string): Set<string> {
  const ascii = text.match(/[A-Za-z_./-]{3,}/g) ?? [];
  const chinese = text.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  const tokens = [...ascii, ...chinese]
    .map((token) => token.toLowerCase())
    .filter((token) => !POLARITY_WORDS.has(token));
  return new Set(tokens);
}

const POSITIVE_RE = /通过|正常|无问题|没有问题|未发现|可用|成功|pass|passed|ok|green/i;
const NEGATIVE_RE = /失败|错误|异常|风险|缺陷|不通过|不可用|未通过|fail|failed|error|bug|broken|red/i;
const POLARITY_WORDS = new Set(["通过", "正常", "无问题", "失败", "错误", "pass", "fail", "error"]);

function findingPolarity(text: string): "positive" | "negative" | "neutral" {
  const positive = POSITIVE_RE.test(text);
  const negative = NEGATIVE_RE.test(text);
  if (positive && !negative) return "positive";
  if (negative && !positive) return "negative";
  return "neutral";
}

function renderWriteConflict(conflict: SubAgentWriteConflict): string {
  return `- ${conflict.path}（${conflict.taskIds.length} 个任务）：${conflict.reason}`;
}

function renderConflict(conflict: SubAgentConflict): string {
  const excerpts = conflict.excerpts.map((e) => `${e.goal.slice(0, 30)}: ${e.text}`).join(" / ");
  return `- ${conflict.topic}：${conflict.reason}；${excerpts}`;
}

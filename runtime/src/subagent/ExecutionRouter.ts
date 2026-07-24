import { randomUUID } from "node:crypto";

import {
  DEFAULT_OUTPUT_CONTRACT,
  DEFAULT_PATCH_LIMITS,
  DEFAULT_PATCH_MODEL_POLICY,
  DEFAULT_PATCH_TOOL_POLICY,
  DEFAULT_READONLY_LIMITS,
  DEFAULT_READONLY_MODEL_POLICY,
  DEFAULT_READONLY_TOOL_POLICY,
  type DelegatedTask,
  type NormalizedDelegatedTask,
  normalizeDelegatedTask,
} from "./delegatedTask.js";
import type { ExecutionRoute, TaskStateSnapshot } from "./executionRoute.js";
import { analyzeTaskRoutingSignals } from "./routingSignals.js";

export interface ExecutionRouterOptions {
  /** 默认上下文 token 上限。 */
  defaultMaxContextTokens?: number;
}

/**
 * 主 Agent 执行策略选择器：决定是否委派子 Agent、工具/模型/上下文策略。
 * 核心：大任务拆小、子任务用干净上下文、只回收结构化结果。
 */
export class ExecutionRouter {
  constructor(private readonly opts: ExecutionRouterOptions = {}) {}

  route(state: TaskStateSnapshot): ExecutionRoute {
    const goal = state.goal.trim();
    if (!goal) {
      return { mode: "ask_user", reason: "缺少明确任务目标" };
    }

    const signals = analyzeTaskRoutingSignals(goal, state.contextSnippet);

    if (!state.forceDelegate) {
      const simple =
        signals.complexity === "low" &&
        signals.fileReferenceCount <= 1 &&
        !state.needsWrite &&
        !state.needsShell &&
        goal.length < 400;
      if (simple) {
        return {
          mode: "direct",
          reason: "任务简单且局部，主 Agent 可直接完成",
        };
      }
    }

    if (state.needsWrite && !state.forceDelegate) {
      return {
        mode: "review",
        reason: "涉及写操作，建议主 Agent 确认后再委派写权限子任务",
      };
    }

    const delegatedTask = this.buildDelegatedTask(state, signals.complexity === "high");
    const toolPolicy = delegatedTask.toolPolicy!;
    const maxTokens = this.opts.defaultMaxContextTokens ?? 8_000;

    return {
      mode: "delegate",
      reason: state.forceDelegate
        ? "主 Agent 显式委派子任务"
        : signals.complexity === "high" || signals.contextTokenEstimate > 4_000
          ? "任务繁琐或上下文压力大，适合拆分子任务并在干净上下文中执行"
          : "可独立推进的局部子任务，适合委派",
      delegatedTask,
      contextPolicy: {
        includeFiles: delegatedTask.context?.files,
        includeSnippets: delegatedTask.context?.snippets,
        includeLogs: delegatedTask.context?.logs,
        maxTokens,
      },
      toolPolicy,
      resultPolicy: {
        returnFormat: delegatedTask.outputContract?.format === "markdown" ? "markdown" : "json",
        compress: true,
        requiredFields: ["status", "summary", "findings", "risks", "nextActions", "confidence"],
      },
    };
  }

  /** 将一条自然语言任务转为可委派任务包（供 dispatch_subagent 默认路径）。 */
  buildDelegatedTaskFromText(
    goal: string,
    opts?: {
      instructions?: string;
      input?: string;
      context?: DelegatedTask["context"];
      writeAllowed?: boolean;
      shellAllowed?: boolean;
      highComplexity?: boolean;
    },
  ): NormalizedDelegatedTask {
    return this.buildDelegatedTask(
      {
        goal,
        contextSnippet: opts?.input,
        needsWrite: opts?.writeAllowed,
        needsShell: opts?.shellAllowed,
        forceDelegate: true,
      },
      opts?.highComplexity ?? false,
      opts,
    );
  }

  private buildDelegatedTask(
    state: TaskStateSnapshot,
    highComplexity: boolean,
    overrides?: {
      instructions?: string;
      input?: string;
      context?: DelegatedTask["context"];
      writeAllowed?: boolean;
      shellAllowed?: boolean;
    },
  ): NormalizedDelegatedTask {
    const writeAllowed = overrides?.writeAllowed ?? state.needsWrite ?? false;
    const shellAllowed = overrides?.shellAllowed ?? state.needsShell ?? false;
    const toolPolicy = writeAllowed
      ? { ...DEFAULT_PATCH_TOOL_POLICY, shellAllowed }
      : { ...DEFAULT_READONLY_TOOL_POLICY, shellAllowed: false };

    const modelPolicy = {
      ...(writeAllowed ? DEFAULT_PATCH_MODEL_POLICY : DEFAULT_READONLY_MODEL_POLICY),
      minQuality: highComplexity ? ("strong" as const) : ("balanced" as const),
    };

    const limits = writeAllowed ? DEFAULT_PATCH_LIMITS : DEFAULT_READONLY_LIMITS;

    return normalizeDelegatedTask({
      id: randomUUID(),
      goal: state.goal.trim(),
      instructions: overrides?.instructions ?? `按说明完成以下子任务：${state.goal.trim()}`,
      input: overrides?.input ?? state.contextSnippet ?? "",
      context: overrides?.context,
      limits,
      toolPolicy,
      modelPolicy,
      outputContract: DEFAULT_OUTPUT_CONTRACT,
    });
  }
}

/** 显式委派时构建路由决策。 */
export function routeDelegatedExecution(
  router: ExecutionRouter,
  goal: string,
  opts?: { force?: boolean; writeAllowed?: boolean },
): ExecutionRoute {
  return router.route({
    goal,
    forceDelegate: opts?.force ?? true,
    needsWrite: opts?.writeAllowed,
  });
}

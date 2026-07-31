import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { LoopChatFn } from "../agent/AgentLoop.js";
import { arbitrateSubAgentConflicts } from "./SubAgentArbitrator.js";
import { mapWithConcurrencyLimit } from "./batchConcurrency.js";
import { DEFAULT_SUBAGENT_BATCH_CONCURRENCY, resolveSubagentTimeoutMs } from "./SubAgentRuntimePolicy.js";
import { normalizeDelegatedTask } from "./delegatedTask.js";
import { ExecutionRouter } from "./ExecutionRouter.js";
import { aggregateSubAgentResultsStructured, SubAgentRunner, type SubAgentRunnerDeps } from "./SubAgentRunner.js";
import type { DelegatedTask } from "./delegatedTask.js";
import type { SubAgentBatchOptions, SubAgentBatchResult } from "./types.js";
import { attemptAutoMergeWriteConflicts, formatWriteMergeSummary } from "./writeConflictAutoMerge.js";
import { intersectBatchPermissionsWithToolPolicy } from "./ToolRouter.js";
import { assertWithinCostBudget, sumModelTurnCost } from "../util/costBudget.js";

const executionRouter = new ExecutionRouter();

export class SubAgentCoordinator {
  private readonly runner: SubAgentRunner;

  constructor(private readonly deps: SubAgentRunnerDeps) {
    this.runner = new SubAgentRunner(deps);
  }

  async runDelegated(
    taskInput: DelegatedTask,
    opts: Omit<import("./types.js").DelegatedTaskRunOptions, "task">,
  ) {
    const task = normalizeDelegatedTask(taskInput);
    const eventId = task.id ?? randomUUID();
    const route = executionRouter.route({
      goal: task.goal,
      contextSnippet: task.input,
      forceDelegate: true,
      needsWrite: task.toolPolicy?.writeAllowed,
      needsShell: task.toolPolicy?.shellAllowed,
    });
    const grantedPermissions = intersectBatchPermissionsWithToolPolicy(
      task.toolPolicy!,
      opts.grantedPermissions ?? this.deps.projectAllowedPermissions ?? ["read"],
    ) ?? [];
    const requestedTimeoutMs = resolveSubagentTimeoutMs(
      opts.timeoutMs ?? task.limits?.maxRuntimeMs,
      this.deps.defaultTimeoutMs,
    );
    const pre = await this.deps.hooks?.dispatch({
      event: "subagent.pre",
      eventId,
      payload: {
        taskId: eventId,
        parentTaskId: opts.parentTaskId,
        writeAllowed: task.toolPolicy?.writeAllowed === true,
        shellAllowed: task.toolPolicy?.shellAllowed === true,
      },
      authority: { permissions: grantedPermissions, timeoutMs: requestedTimeoutMs },
    });
    if (pre && !pre.allowed) {
      return {
        id: eventId,
        taskId: eventId,
        goal: task.goal,
        parentTaskId: opts.parentTaskId,
        status: "failed" as const,
        answer: "",
        steps: [],
        iterations: 0,
        durationMs: 0,
        grantedPermissions: pre.authority.permissions,
        error: pre.reason ?? "subagent_hook_rejected",
      };
    }
    const result = await this.runner.runDelegated({
      task: { ...task, id: eventId },
      ...opts,
      grantedPermissions: pre?.authority.permissions ?? grantedPermissions,
      timeoutMs: pre?.authority.timeoutMs ?? requestedTimeoutMs,
      executionRoute: route.mode === "delegate" ? route : opts.executionRoute,
    });
    const post = await this.deps.hooks?.dispatch({
      event: "subagent.post",
      eventId,
      payload: {
        taskId: eventId,
        parentTaskId: opts.parentTaskId,
        status: result.status,
      },
      authority: { permissions: result.grantedPermissions, timeoutMs: 5_000 },
    });
    if (post && !post.allowed) {
      return {
        ...result,
        status: "failed" as const,
        error: post.reason ?? "subagent_post_hook_rejected",
      };
    }
    return result;
  }

  async runBatch(options: SubAgentBatchOptions): Promise<SubAgentBatchResult> {
    if (!options.tasks.length) throw new Error("tasks 不能为空");

    const parentTaskId = options.parentTaskId ?? randomUUID();
    const entries = options.tasks.map((t) => {
      const task = normalizeDelegatedTask(t);
      const route = executionRouter.route({
        goal: task.goal,
        contextSnippet: task.input,
        forceDelegate: true,
        needsWrite: task.toolPolicy?.writeAllowed,
      });
      return { task, route: route.mode === "delegate" ? route : undefined };
    });

    const start = performance.now();
    const timeoutMs = resolveSubagentTimeoutMs(options.timeoutMs, this.deps.defaultTimeoutMs);
    const concurrency = this.deps.maxBatchConcurrency ?? DEFAULT_SUBAGENT_BATCH_CONCURRENCY;
    const costSliceCount = entries.length + (options.arbitrateConflicts ? 1 : 0);
    const costSliceUsd = options.maxCostUsd == null
      ? undefined
      : options.maxCostUsd / costSliceCount;
    const settled = await mapWithConcurrencyLimit(entries, concurrency, (entry) =>
      this.runDelegated(entry.task, {
          workspaceRoot: options.workspaceRoot,
          parentTaskId,
          grantedPermissions: intersectBatchPermissionsWithToolPolicy(
            entry.task.toolPolicy!,
            options.grantedPermissions,
          ),
          timeoutMs,
          sensitive: options.sensitive,
          parentIntent: options.parentIntent,
          parentWorkflowType: options.parentWorkflowType,
          dispatchDepth: options.dispatchDepth,
          signal: options.signal,
          maxCostUsd: costSliceUsd,
          activityTimeline: options.activityTimeline,
          activityRunId: options.activityRunId,
          activityParentId: options.activityParentId,
        }),
    );

    let aggregate = aggregateSubAgentResultsStructured(settled);
    const summaryGoal = options.tasks.map((t) => t.goal).join(" | ");

    let arbitrationUsage: SubAgentBatchResult["arbitrationUsage"];
    if (options.arbitrateConflicts) {
      const arbitrationCapture = { modelTurns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      const arbitrationChat = withCostBudget(
        resolveArbitrationChat(this.deps, options.sensitive, summaryGoal),
        costSliceUsd,
        arbitrationCapture,
      );
      const arbitration = await arbitrateSubAgentConflicts(arbitrationChat, {
        task: summaryGoal,
        results: settled,
        textConflicts: aggregate.conflicts,
        writeConflicts: aggregate.writeConflicts,
        sensitive: options.sensitive,
      });
      if (arbitration.applied) {
        aggregate = {
          ...aggregate,
          arbitration: {
            applied: arbitration.applied,
            summary: arbitration.summary,
            writeFilePicks: arbitration.writeFilePicks,
          },
          mergedAnswer: `${aggregate.mergedAnswer}\n\n## 模型仲裁\n${arbitration.summary}`,
        };
      } else if (arbitration.skippedReason) {
        aggregate = { ...aggregate, arbitration: { applied: false, summary: "", skippedReason: arbitration.skippedReason } };
      }
      arbitrationUsage = {
        modelTurns: arbitrationCapture.modelTurns,
        toolCalls: 0,
        inputTokens: arbitrationCapture.inputTokens || undefined,
        outputTokens: arbitrationCapture.outputTokens || undefined,
        costUsd: arbitrationCapture.costUsd || undefined,
      };
    }

    if (options.autoMergeWrites && aggregate.writeConflicts.length > 0) {
      const storage = this.deps.registry.getStorage();
      if (storage) {
        const writeMerges = await attemptAutoMergeWriteConflicts(
          storage,
          options.workspaceRoot,
          aggregate.writeConflicts,
          settled,
          {
            arbitrationSummary: aggregate.arbitration?.summary,
            writeFilePickStrategy: options.writeFilePickStrategy ?? "arbitration",
          },
        );
        const unresolved = aggregate.writeConflicts.filter(
          (conflict) => writeMerges.find((attempt) => attempt.path === conflict.path)?.status !== "merged",
        );
        const mergeSummary = formatWriteMergeSummary(writeMerges);
        aggregate = {
          ...aggregate,
          writeConflicts: unresolved,
          writeMerges,
          mergedAnswer: mergeSummary ? `${aggregate.mergedAnswer}\n\n${mergeSummary}` : aggregate.mergedAnswer,
        };
      }
    }

    return {
      parentTaskId,
      results: settled,
      summary: aggregate.mergedAnswer,
      aggregate,
      durationMs: Math.round(performance.now() - start),
      arbitrationUsage,
    };
  }

}

function withCostBudget(
  chat: LoopChatFn,
  maxCostUsd: number | undefined,
  capture: { modelTurns: number; inputTokens: number; outputTokens: number; costUsd: number },
): LoopChatFn {
  return async (request, options) => {
    assertWithinCostBudget(capture.costUsd, maxCostUsd);
    const response = await chat(request, {
      ...options,
      spentCostUsd: capture.costUsd,
      maxCostUsd: maxCostUsd ?? options?.maxCostUsd,
    });
    capture.modelTurns += 1;
    capture.inputTokens += response.usage?.inputTokens ?? 0;
    capture.outputTokens += response.usage?.outputTokens ?? 0;
    capture.costUsd = sumModelTurnCost([capture.costUsd, response.costUsd]);
    assertWithinCostBudget(capture.costUsd, maxCostUsd);
    return response;
  };
}

function resolveArbitrationChat(deps: SubAgentRunnerDeps, sensitive?: boolean, goal?: string): LoopChatFn {
  if (deps.createChatForDelegatedTask) {
    const taskObj = normalizeDelegatedTask({
      goal: goal ?? "仲裁子任务冲突",
      instructions: "只读复核多子任务冲突并给出建议",
      input: "",
    });
    return deps.createChatForDelegatedTask(taskObj, { sensitive, parentTaskId: randomUUID() });
  }
  return deps.chat;
}

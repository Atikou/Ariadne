import { z } from "zod";

import {
  delegatedTaskSchema,
  MAX_DELEGATED_TASKS_PER_BATCH,
  normalizeDelegatedTask,
} from "../subagent/delegatedTask.js";
import type { DelegatedTask, SubAgentStructuredResult } from "../subagent/delegatedTask.js";
import type { ModelSelection } from "../subagent/types.js";
import type { ToolPermission } from "../core/permissions.js";
import type { Tool } from "./types.js";

export const DISPATCH_SUBAGENT_TOOL_NAME = "dispatch_subagent";

export const dispatchSubagentInputSchema = z.object({
  tasks: z.array(delegatedTaskSchema).min(1).max(MAX_DELEGATED_TASKS_PER_BATCH),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
  grantedPermissions: z
    .array(z.enum(["read", "write", "shell", "network", "dangerous"]))
    .optional(),
  arbitrateConflicts: z.boolean().optional(),
  autoMergeWrites: z.boolean().optional(),
  writeFilePickStrategy: z.enum(["latest", "earliest", "arbitration"]).optional(),
}).strict();

export type DispatchSubagentInput = z.infer<typeof dispatchSubagentInputSchema>;

export interface DispatchSubagentOutput {
  dispatchId: string;
  mode: "single" | "batch";
  parentTaskId?: string;
  summary: string;
  results: Array<{
    id: string;
    taskId: string;
    goal: string;
    status: string;
    answer: string;
    structured?: SubAgentStructuredResult;
    durationMs: number;
    iterations: number;
    error?: string;
    modelUsed?: ModelSelection;
    workspaceIsolation?: {
      kind: "isolated_snapshot";
      changedFiles: string[];
      unifiedDiff: string;
      diffTruncated: boolean;
      appliedToPrimary: false;
    };
  }>;
  aggregate?: {
    status: string;
    completed: number;
    failed: number;
    timedOut: number;
    conflicts: Array<{ topic: string; taskIds: string[]; reason: string }>;
    writeConflicts?: Array<{ path: string; taskIds: string[]; reason: string }>;
    writeMerges?: Array<{
      path: string;
      status: string;
      changeId?: string;
      reason: string;
      appliedPatches: number;
    }>;
    arbitration?: { applied: boolean; summary: string };
    mergedAnswer: string;
  };
  durationMs: number;
}

export const dispatchSubagentTool: Tool<typeof dispatchSubagentInputSchema, DispatchSubagentOutput> = {
  name: DISPATCH_SUBAGENT_TOOL_NAME,
  description:
    "将大任务拆分为子任务委派给子 Agent：子 Agent 在干净、最小上下文中自行执行，只把压缩结构化结果带回。参数 tasks: DelegatedTask[]，每项含 goal/instructions/toolPolicy/modelPolicy。⚠️ 可能有副作用：当某个子任务设置 toolPolicy.writeAllowed/shellAllowed 且 grantedPermissions 含 write/shell 时，子 Agent 会写文件或执行命令，因此本工具按「可能有副作用」对待。",
  inputSchema: dispatchSubagentInputSchema,
  // 派发动作本身是 read 级（不直接触碰文件系统），但被派发的子 Agent 可在授权下写盘/跑命令，
  // 故 hasSideEffect 取保守的 true，使工具清单/确认提示如实告知「可能有副作用」。
  permission: "read",
  possiblePermissions: ["read", "write", "shell"],
  resolvePermissions(rawInput) {
    const parsed = dispatchSubagentInputSchema.safeParse(rawInput);
    if (!parsed.success) return ["read"];
    const input = parsed.data;
    const permissions: ToolPermission[] = ["read"];
    if (input.tasks.some((task) => task.toolPolicy?.writeAllowed === true)) permissions.push("write");
    if (input.tasks.some((task) => task.toolPolicy?.shellAllowed === true)) permissions.push("shell");
    return permissions;
  },
  hasSideEffect: true,
  timeoutMs: 300_000,
  async execute(input, context) {
    const depth = context.subAgentDispatchDepth ?? 0;
    const max = context.maxSubAgentDispatchDepth ?? 1;
    if (depth >= max) {
      throw new Error(`已达到子 Agent 派生深度上限（${max}，当前 depth=${depth}）`);
    }

    const workflow = context.subAgentWorkflow;
    if (!workflow) {
      throw new Error("子 Agent 工作流未配置（subAgentWorkflow 缺失）");
    }

    const tasks = input.tasks.map((task) => normalizeDelegatedTask(task));

    const parentTaskId = context.taskId;
    const sensitive = context.sensitive;
    const childDepth = depth + 1;
    const parentIntent = context.parentAgentIntent;
    const parentWorkflowType = context.parentAgentWorkflowType;
    const runOpts = {
      tasks,
      workspaceRoot: context.workspaceRoot,
      parentTaskId,
      timeoutMs: input.timeoutMs,
      sensitive,
      parentIntent,
      parentWorkflowType,
      grantedPermissions: input.grantedPermissions,
      dispatchDepth: childDepth,
      arbitrateConflicts: input.arbitrateConflicts,
      autoMergeWrites: input.autoMergeWrites,
      writeFilePickStrategy: input.writeFilePickStrategy,
      signal: context.signal,
      maxCostUsd: context.subAgentCostBudgetUsd,
    };

    const dispatch = workflow.submit(runOpts);
    const completed = await dispatch.completion;
    if (completed.mode === "single") {
      const result = completed.result;
      return {
        dispatchId: dispatch.dispatchId,
        mode: "single",
        parentTaskId,
        summary: formatSingleSummary(result),
        results: [toResultItem(result)],
        durationMs: result.durationMs,
      };
    }

    const batch = completed.result;
    return {
      dispatchId: dispatch.dispatchId,
      mode: "batch",
      parentTaskId: batch.parentTaskId,
      summary: batch.summary,
      results: batch.results.map(toResultItem),
      aggregate: {
        status: batch.aggregate.status,
        completed: batch.aggregate.completed,
        failed: batch.aggregate.failed,
        timedOut: batch.aggregate.timedOut,
        conflicts: batch.aggregate.conflicts.map((c) => ({
          topic: c.topic,
          taskIds: c.taskIds,
          reason: c.reason,
        })),
        writeConflicts: batch.aggregate.writeConflicts.map((w) => ({
          path: w.path,
          taskIds: w.taskIds,
          reason: w.reason,
        })),
        writeMerges: batch.aggregate.writeMerges?.map((w) => ({
          path: w.path,
          status: w.status,
          changeId: w.changeId,
          reason: w.reason,
          appliedPatches: w.appliedPatches,
        })),
        arbitration: batch.aggregate.arbitration
          ? { applied: batch.aggregate.arbitration.applied, summary: batch.aggregate.arbitration.summary }
          : undefined,
        mergedAnswer: batch.aggregate.mergedAnswer,
      },
      arbitrationUsage: batch.arbitrationUsage,
      durationMs: batch.durationMs,
    };
  },
};

function toResultItem(result: {
  id: string;
  taskId: string;
  goal: string;
  status: string;
  answer: string;
  structured?: SubAgentStructuredResult;
  durationMs: number;
  iterations: number;
  error?: string;
  modelUsed?: ModelSelection;
  workspaceIsolation?: import("../subagent/SubAgentWorkspaceManager.js").SubAgentWorkspaceArtifact;
  usage?: import("../subagent/types.js").SubAgentRunResult["usage"];
}) {
  return {
    id: result.id,
    taskId: result.taskId,
    goal: result.goal,
    status: result.status,
    answer: result.answer,
    structured: result.structured,
    durationMs: result.durationMs,
    iterations: result.iterations,
    error: result.error,
    modelUsed: result.modelUsed,
    workspaceIsolation: result.workspaceIsolation,
    usage: result.usage,
  };
}

function formatSingleSummary(result: {
  goal: string;
  status: string;
  answer: string;
  structured?: SubAgentStructuredResult;
  error?: string;
}): string {
  const head = `[${result.goal.slice(0, 40)}] ${result.status}`;
  const body = result.structured?.summary ?? (result.error ? `${result.error}\n${result.answer}` : result.answer);
  return `${head}\n${body}`;
}

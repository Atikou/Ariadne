import { z } from "zod";

import type { RunBudget } from "../agent/RunPolicyTypes.js";
import { mergeRunBudget, MODE_BASE_BUDGETS } from "../agent/runBudgetDefaults.js";

export const MAX_DELEGATED_TASKS_PER_BATCH = 8;

export const MODEL_CAPABILITIES = [
  "reasoning",
  "code",
  "vision",
  "summary",
  "tool_use",
  "long_context",
] as const;
export const MODEL_QUALITIES = ["fast", "balanced", "strong"] as const;
export const MODEL_PREFERENCES = ["local", "remote", "auto"] as const;
export const DELEGATED_OUTPUT_FORMATS = ["text", "json", "markdown"] as const;

export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];
export type ModelQuality = (typeof MODEL_QUALITIES)[number];
export type ModelPrefer = (typeof MODEL_PREFERENCES)[number];
export type DelegatedOutputFormat = (typeof DELEGATED_OUTPUT_FORMATS)[number];

export const delegatedTaskContextSchema = z
  .object({
    files: z.array(z.string()).optional(),
    snippets: z.array(z.string()).optional(),
    logs: z.array(z.string()).optional(),
    previousResults: z.array(z.string()).optional(),
    projectFacts: z.array(z.string()).optional(),
  })
  .strict();

export const delegatedTaskLimitsInputSchema = z
  .object({
    maxModelTurns: z.number().int().positive().optional(),
    maxToolCalls: z.number().int().positive().optional(),
    maxReadCalls: z.number().int().positive().optional(),
    maxWriteCalls: z.number().int().nonnegative().optional(),
    maxShellCalls: z.number().int().nonnegative().optional(),
    maxRuntimeMs: z.number().int().positive().optional(),
  })
  .strict();

export const delegatedTaskLimitsSchema = z
  .object({
    maxModelTurns: z.number().int().positive(),
    maxToolCalls: z.number().int().positive(),
    maxReadCalls: z.number().int().positive(),
    maxWriteCalls: z.number().int().nonnegative(),
    maxShellCalls: z.number().int().nonnegative(),
    maxRuntimeMs: z.number().int().positive(),
  })
  .strict();

export const delegatedTaskToolPolicyInputSchema = z
  .object({
    allowedTools: z.array(z.string()).optional(),
    writeAllowed: z.boolean().optional(),
    shellAllowed: z.boolean().optional(),
  })
  .strict();

export const delegatedTaskToolPolicySchema = z
  .object({
    allowedTools: z.array(z.string()),
    writeAllowed: z.boolean(),
    shellAllowed: z.boolean(),
  })
  .strict();

export const delegatedTaskModelPolicyInputSchema = z
  .object({
    prefer: z.enum(MODEL_PREFERENCES).optional(),
    allowRemoteEscalation: z.boolean().optional(),
    requiredCapabilities: z.array(z.enum(MODEL_CAPABILITIES)).optional(),
    minQuality: z.enum(MODEL_QUALITIES).optional(),
  })
  .strict();

export const delegatedTaskModelPolicySchema = z
  .object({
    prefer: z.enum(MODEL_PREFERENCES),
    allowRemoteEscalation: z.boolean(),
    requiredCapabilities: z.array(z.enum(MODEL_CAPABILITIES)),
    minQuality: z.enum(MODEL_QUALITIES),
  })
  .strict();

export const delegatedTaskOutputContractInputSchema = z
  .object({
    format: z.enum(DELEGATED_OUTPUT_FORMATS),
    requiredSections: z.array(z.string()).optional(),
  })
  .strict();

export const delegatedTaskOutputContractSchema = z
  .object({
    format: z.enum(DELEGATED_OUTPUT_FORMATS),
    requiredSections: z.array(z.string()),
  })
  .strict();

/** 唯一的外部 DelegatedTask 输入契约；工具与 HTTP 入口共同复用。 */
export const delegatedTaskSchema = z
  .object({
    id: z.string().min(1).max(200).optional(),
    goal: z.string().trim().min(1).max(4_000),
    instructions: z.string().max(4_000).optional(),
    input: z.string().max(8_000).optional(),
    context: delegatedTaskContextSchema.optional(),
    limits: delegatedTaskLimitsInputSchema.optional(),
    toolPolicy: delegatedTaskToolPolicyInputSchema.optional(),
    modelPolicy: delegatedTaskModelPolicyInputSchema.optional(),
    outputContract: delegatedTaskOutputContractInputSchema.optional(),
  })
  .strict();

export const normalizedDelegatedTaskSchema = delegatedTaskSchema.extend({
  instructions: z.string().max(4_000),
  input: z.string().max(8_000),
  limits: delegatedTaskLimitsSchema,
  toolPolicy: delegatedTaskToolPolicySchema,
  modelPolicy: delegatedTaskModelPolicySchema,
  outputContract: delegatedTaskOutputContractSchema,
});

export type DelegatedTask = z.infer<typeof delegatedTaskSchema>;
export type NormalizedDelegatedTask = z.infer<typeof normalizedDelegatedTaskSchema>;
export type DelegatedTaskContext = z.infer<typeof delegatedTaskContextSchema>;
export type DelegatedTaskLimitsInput = z.infer<typeof delegatedTaskLimitsInputSchema>;
export type DelegatedTaskLimits = z.infer<typeof delegatedTaskLimitsSchema>;
export type DelegatedTaskToolPolicy = z.infer<typeof delegatedTaskToolPolicySchema>;
export type DelegatedTaskModelPolicy = z.infer<typeof delegatedTaskModelPolicySchema>;
export type DelegatedTaskOutputContract = z.infer<typeof delegatedTaskOutputContractSchema>;

/** 子 Agent 结构化回收结果（给主 Agent 的压缩输出）。 */
export interface SubAgentStructuredResult {
  taskId: string;
  status: "success" | "partial" | "failed";
  summary: string;
  findings: string[];
  evidence?: Array<{ source: string; detail: string }>;
  risks?: string[];
  nextActions?: string[];
  usedModel?: string;
  usedTools?: string[];
  confidence?: number;
}

export const DEFAULT_READONLY_TOOL_POLICY: DelegatedTaskToolPolicy = {
  allowedTools: [
    "read_file",
    "list_files",
    "search_text",
    "locate_relevant_files",
    "symbol_search",
    "context_pack",
    "git_status",
    "git_diff",
    "diff_file",
  ],
  writeAllowed: false,
  shellAllowed: false,
};

export const DEFAULT_PATCH_TOOL_POLICY: DelegatedTaskToolPolicy = {
  allowedTools: [
    "read_file",
    "list_files",
    "search_text",
    "apply_patch",
    "write_file",
    "diff_file",
    "backup_file",
  ],
  writeAllowed: true,
  shellAllowed: false,
};

export const DEFAULT_READONLY_LIMITS: DelegatedTaskLimits = {
  maxModelTurns: 16,
  maxToolCalls: 20,
  maxReadCalls: 20,
  maxWriteCalls: 0,
  maxShellCalls: 0,
  maxRuntimeMs: 180_000,
};

export const DEFAULT_PATCH_LIMITS: DelegatedTaskLimits = {
  maxModelTurns: 12,
  maxToolCalls: 16,
  maxReadCalls: 12,
  maxWriteCalls: 6,
  maxShellCalls: 0,
  maxRuntimeMs: 240_000,
};

export const DEFAULT_SHELL_LIMITS: DelegatedTaskLimits = {
  ...DEFAULT_READONLY_LIMITS,
  maxToolCalls: 12,
  maxShellCalls: 4,
  maxRuntimeMs: 240_000,
};

export const DEFAULT_READONLY_MODEL_POLICY: DelegatedTaskModelPolicy = {
  prefer: "auto",
  allowRemoteEscalation: true,
  requiredCapabilities: [],
  minQuality: "balanced",
};

export const DEFAULT_PATCH_MODEL_POLICY: DelegatedTaskModelPolicy = {
  prefer: "auto",
  allowRemoteEscalation: true,
  requiredCapabilities: ["code", "tool_use"],
  minQuality: "balanced",
};

export const DEFAULT_OUTPUT_CONTRACT: DelegatedTaskOutputContract = {
  format: "json",
  requiredSections: ["summary", "findings", "risks", "nextActions"],
};

/** 将 DelegatedTaskLimits 转为 AgentLoop RunBudget。 */
export function limitsToRunBudget(limits: DelegatedTaskLimits, writeAllowed = false): RunBudget {
  const budget = mergeRunBudget(MODE_BASE_BUDGETS.chat, {
    maxModelTurns: limits.maxModelTurns ?? 16,
    maxToolCalls: limits.maxToolCalls ?? 20,
    maxReadCalls: limits.maxReadCalls ?? 20,
    maxWriteCalls: writeAllowed ? Math.min(limits.maxWriteCalls ?? limits.maxToolCalls ?? 6, 6) : 0,
    maxShellCalls: limits.maxShellCalls ?? 0,
    maxRuntimeMs: limits.maxRuntimeMs ?? 180_000,
  });
  // mergeRunBudget 将 0 视为“未覆盖”；子 Agent 的显式零预算必须保留为硬边界。
  if (!writeAllowed) budget.maxWriteCalls = 0;
  if ((limits.maxShellCalls ?? 0) === 0) budget.maxShellCalls = 0;
  return budget;
}

/** 合并部分 DelegatedTask 字段为完整任务（填充默认策略）。 */
export function normalizeDelegatedTask(input: DelegatedTask): NormalizedDelegatedTask {
  const partial = delegatedTaskSchema.parse(input);
  const writeAllowed = partial.toolPolicy?.writeAllowed ?? false;
  const shellAllowed = partial.toolPolicy?.shellAllowed ?? false;
  const defaultTool = writeAllowed ? DEFAULT_PATCH_TOOL_POLICY : DEFAULT_READONLY_TOOL_POLICY;
  const defaultLimits = writeAllowed
    ? DEFAULT_PATCH_LIMITS
    : shellAllowed
      ? DEFAULT_SHELL_LIMITS
      : DEFAULT_READONLY_LIMITS;
  const defaultModel = writeAllowed ? DEFAULT_PATCH_MODEL_POLICY : DEFAULT_READONLY_MODEL_POLICY;

  return normalizedDelegatedTaskSchema.parse({
    id: partial.id,
    goal: partial.goal.trim(),
    instructions: (partial.instructions ?? partial.goal).trim(),
    input: (partial.input ?? "").trim(),
    context: partial.context,
    limits: normalizeTaskLimits(defaultLimits, partial.limits),
    toolPolicy: { ...defaultTool, ...partial.toolPolicy, allowedTools: partial.toolPolicy?.allowedTools ?? defaultTool.allowedTools },
    modelPolicy: { ...defaultModel, ...partial.modelPolicy },
    outputContract: { ...DEFAULT_OUTPUT_CONTRACT, ...partial.outputContract },
  });
}

function normalizeTaskLimits(
  defaultLimits: DelegatedTaskLimits,
  input: DelegatedTaskLimitsInput | undefined,
): DelegatedTaskLimits {
  const raw = (input ?? {}) as Record<string, unknown>;
  return {
    maxModelTurns: readPositiveIntegerLimit(raw, "maxModelTurns", defaultLimits.maxModelTurns),
    maxToolCalls: readPositiveIntegerLimit(raw, "maxToolCalls", defaultLimits.maxToolCalls),
    maxReadCalls: readPositiveIntegerLimit(raw, "maxReadCalls", defaultLimits.maxReadCalls),
    maxWriteCalls: readNonNegativeIntegerLimit(raw, "maxWriteCalls", defaultLimits.maxWriteCalls),
    maxShellCalls: readNonNegativeIntegerLimit(raw, "maxShellCalls", defaultLimits.maxShellCalls),
    maxRuntimeMs: readPositiveIntegerLimit(raw, "maxRuntimeMs", defaultLimits.maxRuntimeMs),
  };
}

function readPositiveIntegerLimit(
  raw: Record<string, unknown>,
  key: keyof DelegatedTaskLimits,
  fallback: number,
): number {
  return readIntegerLimit(raw, key, fallback, 1);
}

function readNonNegativeIntegerLimit(
  raw: Record<string, unknown>,
  key: keyof DelegatedTaskLimits,
  fallback: number,
): number {
  return readIntegerLimit(raw, key, fallback, 0);
}

function readIntegerLimit(
  raw: Record<string, unknown>,
  key: keyof DelegatedTaskLimits,
  fallback: number,
  min: number,
): number {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new Error(`DelegatedTaskLimits.${key} must be an integer >= ${min}`);
  }
  return value;
}

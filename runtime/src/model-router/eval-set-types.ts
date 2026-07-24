import { z } from "zod";

import {
  EXECUTION_STRATEGY_VALUES,
  MODEL_LEVEL_VALUES,
  TASK_TYPE_VALUES,
  type ExecutionStrategy,
  type ModelLevel,
  type RouterInput,
  type TaskType,
} from "./types.js";

export interface EvalSetCase {
  id: string;
  title: string;
  input: string;
  routerInput?: Partial<RouterInput>;
  expectedTaskType?: TaskType;
  expectedLevel?: ModelLevel;
  expectedStrategy?: ExecutionStrategy;
  tags?: string[];
}

export const EvalSetVerdictSchema = z.enum(["pass", "fail", "skipped"]);
export type EvalSetVerdict = z.infer<typeof EvalSetVerdictSchema>;

export const EvalSetScopeSchema = z.enum(["rule", "smart"]);
export type EvalSetScope = z.infer<typeof EvalSetScopeSchema>;

const TaskTypeSchema = z.enum(TASK_TYPE_VALUES);
const ModelLevelSchema = z.union([
  z.literal(MODEL_LEVEL_VALUES[0]),
  z.literal(MODEL_LEVEL_VALUES[1]),
  z.literal(MODEL_LEVEL_VALUES[2]),
  z.literal(MODEL_LEVEL_VALUES[3]),
]);
const ExecutionStrategySchema = z.enum(EXECUTION_STRATEGY_VALUES);

export const EvalSetCaseResultSchema = z.object({
  caseId: z.string(),
  caseTitle: z.string().optional(),
  inputPreview: z.string().optional(),
  verdict: EvalSetVerdictSchema,
  expectedTaskType: TaskTypeSchema.optional(),
  actualTaskType: TaskTypeSchema.optional(),
  expectedLevel: ModelLevelSchema.optional(),
  actualLevel: ModelLevelSchema.optional(),
  expectedStrategy: ExecutionStrategySchema.optional(),
  actualStrategy: ExecutionStrategySchema.optional(),
  notes: z.array(z.string()).optional(),
}).strict();
export type EvalSetCaseResult = z.infer<typeof EvalSetCaseResultSchema>;

export const EvalSetRunSummarySchema = z.object({
  runId: z.string().uuid(),
  setName: z.string(),
  scope: EvalSetScopeSchema,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  results: z.array(EvalSetCaseResultSchema),
}).strict().superRefine((summary, ctx) => {
  if (summary.total !== summary.passed + summary.failed + summary.skipped) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "评测计数总和不一致" });
  }
  if (summary.total !== summary.results.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "评测结果数量与 total 不一致" });
  }
});
export type EvalSetRunSummary = z.infer<typeof EvalSetRunSummarySchema>;

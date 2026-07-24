import { z } from "zod";

export const PLAN_SCHEMA_VERSION = "1.0";

export const PlanStatusSchema = z.enum([
  "draft",
  "validated",
  "awaiting_approval",
  "approved",
  "scheduled",
  "running",
  "completed",
  "rejected",
  "cancelled",
  "failed",
  "paused",
  "superseded",
  "rollback_required",
  "rolled_back",
]);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;

export const ExecutablePlanStatuses = new Set<PlanStatus>(["approved", "scheduled"]);

export const PlanModeSchema = z.enum(["plan", "implement", "debug", "review"]);
export type PlanMode = z.infer<typeof PlanModeSchema>;

export const AgentPlanModeSchema = z.enum(["chat", "plan", "execute", "review", "debug"]);
export type AgentPlanMode = z.infer<typeof AgentPlanModeSchema>;

export const AgentStepSchema = z.object({
  id: z.string(),
  intent: z.string(),
  tool: z.string().optional(),
  reason: z.string(),
  status: z.enum(["pending", "done", "skipped", "failed"]),
});
export type AgentStep = z.infer<typeof AgentStepSchema>;

export const AgentStepPlanSchema = z.object({
  runId: z.string(),
  mode: AgentPlanModeSchema,
  ephemeral: z.literal(true),
  steps: z.array(AgentStepSchema),
  createdAt: z.string(),
});
export type AgentStepPlan = z.infer<typeof AgentStepPlanSchema>;

export const UserVisibleTodoSchema = z.object({
  id: z.string(),
  priority: z.enum(["P0", "P1", "P2", "P3"]),
  title: z.string(),
  goal: z.string(),
  relatedFiles: z.array(z.string()).optional(),
  implementationIdea: z.string(),
  acceptanceCriteria: z.array(z.string()),
  riskLevel: z.enum(["low", "medium", "high"]),
  allowAutoImplement: z.boolean(),
  requiresUserConfirmation: z.boolean(),
}).strict();
export type UserVisibleTodo = z.infer<typeof UserVisibleTodoSchema>;

export const PlanRiskSchema = z.object({
  id: z.string(),
  level: z.enum(["low", "medium", "high"]),
  title: z.string(),
  mitigation: z.string().optional(),
}).strict();
export type PlanRisk = z.infer<typeof PlanRiskSchema>;

export const UserVisiblePlanSchema = z.object({
  kind: z.literal("user_visible_plan"),
  id: z.string(),
  sourceRunId: z.string(),
  sessionId: z.string().optional(),
  title: z.string(),
  markdown: z.string(),
  todos: z.array(UserVisibleTodoSchema),
  risks: z.array(PlanRiskSchema),
  requiresUserConfirmation: z.boolean(),
  createdAt: z.string(),
}).strict();
export type UserVisiblePlan = z.infer<typeof UserVisiblePlanSchema>;

export const StepTypeSchema = z.enum([
  "tool_call",
  "model_call",
  "approval",
  "checkpoint",
  "manual",
]);
export type InternalStepType = z.infer<typeof StepTypeSchema>;

export const RiskLevelSchema = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const InternalPlanStepSchema = z.object({
  stepId: z.string(),
  type: StepTypeSchema,
  title: z.string(),
  description: z.string().optional(),
  objective: z.string().optional(),
  toolName: z.string().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  dependsOn: z.array(z.string()).default([]),
  riskLevel: RiskLevelSchema,
  expectedOutput: z.string().optional(),
  requiresApproval: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
  requiredPermissions: z
    .array(z.enum(["read", "write", "shell", "network", "dangerous"]))
    .default(["read"]),
  priority: z.number().int().default(100),
});
export type InternalPlanStep = z.infer<typeof InternalPlanStepSchema>;

export const InternalTaskPlanSchema = z.object({
  kind: z.literal("internal_task_plan"),
  schemaVersion: z.string(),
  planId: z.string(),
  version: z.number().int().positive(),
  status: PlanStatusSchema,
  origin: z.object({
    type: z.enum(["planner", "revision", "import_preview", "legacy_ingest", "user_visible_plan"]),
    sessionId: z.string().optional(),
    requestId: z.string().optional(),
  }),
  goal: z.string(),
  mode: PlanModeSchema,
  scope: z.object({
    workspaceRoot: z.string(),
    projectId: z.string().optional(),
    sessionId: z.string().optional(),
  }),
  inputs: z.array(z.string()).default([]),
  outputs: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  scopeDetail: z
    .object({
      inScope: z.array(z.string()).default([]),
      outOfScope: z.array(z.string()).default([]),
    })
    .default({ inScope: [], outOfScope: [] }),
  budget: z.object({
    maxSteps: z.number().int().positive().default(50),
    maxToolCalls: z.number().int().positive().default(30),
    maxWriteCalls: z.number().int().nonnegative().default(10),
    maxShellCalls: z.number().int().nonnegative().default(5),
  }),
  permissions: z.object({
    allowWrite: z.boolean().default(true),
    allowShell: z.boolean().default(true),
    allowDangerousShell: z.boolean().default(false),
    requireApprovalBeforeWrite: z.boolean().default(true),
  }),
  steps: z.array(InternalPlanStepSchema).min(1),
  guards: z.object({
    requiredCleanGitStatus: z.boolean().default(false),
    writeSet: z.array(z.string()).default([]),
    readSet: z.array(z.string()).default([]),
    forbiddenPaths: z.array(z.string()).default([".env", "node_modules", ".git"]),
  }),
  rollback: z.object({
    strategy: z.enum(["none", "backup_and_patch"]).default("backup_and_patch"),
    createBackupBeforeWrite: z.boolean().default(true),
  }),
  audit: z.object({
    createdAt: z.string(),
    createdBy: z.string(),
    planHash: z.string(),
    updatedAt: z.string().optional(),
  }),
});
export type InternalTaskPlan = z.infer<typeof InternalTaskPlanSchema>;

/**
 * 运行时唯一可执行计划表示（与 `InternalTaskPlan` 同构）。
 * 新代码应以此为准；`agent/types.Plan` 仅保留给 Planner 输出与 TaskRunner 边界。
 */
export type ExecutableTaskPlan = InternalTaskPlan;

export const PublicPlanStepSchema = z.object({
  stepId: z.string().optional(),
  title: z.string(),
  description: z.string().optional(),
  riskLevel: RiskLevelSchema,
  requiresApproval: z.boolean(),
}).strict();
export type PublicPlanStep = z.infer<typeof PublicPlanStepSchema>;

export const PublicPlanJsonSchema = z.object({
  kind: z.literal("public_plan_preview"),
  executable: z.literal(false),
  planId: z.string(),
  version: z.number().int().positive(),
  title: z.string(),
  summary: z.string(),
  steps: z.array(PublicPlanStepSchema),
  warnings: z.array(z.string()),
}).strict();
export type PublicPlanJson = z.infer<typeof PublicPlanJsonSchema>;

export const RenderedPlanPreviewSchema = z.object({
  planId: z.string(),
  version: z.number().int().positive(),
  format: z.enum(["markdown", "json"]),
  content: z.string(),
  generatedAt: z.string(),
  sourcePlanHash: z.string(),
});
export type RenderedPlanPreview = z.infer<typeof RenderedPlanPreviewSchema>;

export type PlanValidationErrorCode =
  | "INVALID_SCHEMA"
  | "PLAN_NOT_FOUND"
  | "PLAN_STATUS_CONFLICT"
  | "INVALID_PLAN_KIND"
  | "PLAN_NOT_APPROVED"
  | "PLAN_HASH_MISMATCH"
  | "UNKNOWN_TOOL"
  | "FORBIDDEN_PATH"
  | "BUDGET_EXCEEDED"
  | "INVALID_DEPENDS_ON"
  | "EXECUTABLE_PREVIEW_REJECTED"
  | "MISSING_TOOL_BINDING";

export class PlanValidationError extends Error {
  constructor(
    readonly code: PlanValidationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PlanValidationError";
  }
}

/** 拒绝用户传入的可展示计划 JSON 作为执行体。 */
export function rejectExecutablePreview(input: unknown): void {
  if (!input || typeof input !== "object") return;
  const record = input as Record<string, unknown>;
  if (record.kind === "public_plan_preview" || record.executable === false) {
    throw new PlanValidationError(
      "EXECUTABLE_PREVIEW_REJECTED",
      "PublicPlanJson 不可执行，请通过 Planner 生成 InternalTaskPlan 并审批后执行",
    );
  }
}

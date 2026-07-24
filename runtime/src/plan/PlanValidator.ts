import { validateTaskGraph } from "../agent/taskGraph.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import { computePlanHash } from "./planHash.js";
import {
  ExecutablePlanStatuses,
  InternalTaskPlanSchema,
  PublicPlanJsonSchema,
  PlanValidationError,
  rejectExecutablePreview,
  type InternalTaskPlan,
  type PlanStatus,
} from "./types.js";

export interface PlanValidatorOptions {
  workspaceRoot: string;
  registry: ToolRegistry;
  supportedSchemaVersions?: string[];
}

export class PlanValidator {
  private readonly supportedVersions: Set<string>;

  constructor(private readonly options: PlanValidatorOptions) {
    this.supportedVersions = new Set(options.supportedSchemaVersions ?? ["1.0"]);
  }

  validate(plan: InternalTaskPlan): InternalTaskPlan {
    rejectExecutablePreview(plan);

    if (plan.kind !== "internal_task_plan") {
      throw new PlanValidationError("INVALID_PLAN_KIND", "kind 必须为 internal_task_plan");
    }

    if (!this.supportedVersions.has(plan.schemaVersion)) {
      throw new PlanValidationError("INVALID_SCHEMA", `不支持的 schemaVersion: ${plan.schemaVersion}`);
    }

    const parsed = InternalTaskPlanSchema.safeParse(plan);
    if (!parsed.success) {
      throw new PlanValidationError("INVALID_SCHEMA", parsed.error.message);
    }

    const internal = parsed.data;
    this.validateDependsOn(internal);
    this.validateTools(internal);
    this.validatePaths(internal);
    this.validateBudget(internal);
    this.validateRiskApproval(internal);
    this.validateHash(internal);

    return { ...internal, status: "validated" };
  }

  assertExecutable(plan: InternalTaskPlan, expectedHash?: string): void {
    rejectExecutablePreview(plan);
    if (plan.kind !== "internal_task_plan") {
      throw new PlanValidationError("INVALID_PLAN_KIND", "INVALID_PLAN_KIND");
    }
    if (!ExecutablePlanStatuses.has(plan.status)) {
      throw new PlanValidationError(
        "PLAN_NOT_APPROVED",
        `计划状态 ${plan.status} 不可执行，需要 approved 或 scheduled`,
      );
    }
    this.assertToolBindings(plan);
    this.validateHash(plan, expectedHash);
  }

  /** 执行前强制：每步须为可调用 tool_call，禁止无 tool 的 no-op 步骤。 */
  assertToolBindings(plan: InternalTaskPlan): void {
    if (plan.steps.length === 0) {
      throw new PlanValidationError("MISSING_TOOL_BINDING", "计划至少包含一个可执行步骤");
    }
    for (const step of plan.steps) {
      if (step.type !== "tool_call" || !step.toolName) {
        throw new PlanValidationError(
          "MISSING_TOOL_BINDING",
          `步骤 ${step.stepId} 缺少 tool 绑定（type=tool_call 且 toolName 必填）`,
        );
      }
      if (!step.args || Object.keys(step.args).length === 0) {
        throw new PlanValidationError(
          "MISSING_TOOL_BINDING",
          `步骤 ${step.stepId} 缺少 toolInput/args`,
        );
      }
      if (!this.options.registry.get(step.toolName)) {
        throw new PlanValidationError("UNKNOWN_TOOL", `未知工具：${step.toolName}`);
      }
    }
  }

  rejectPublicPreview(input: unknown): void {
    rejectExecutablePreview(input);
    const parsed = PublicPlanJsonSchema.safeParse(input);
    if (parsed.success) {
      throw new PlanValidationError(
        "EXECUTABLE_PREVIEW_REJECTED",
        "PublicPlanJson 不能被 TaskExecutor 执行",
      );
    }
  }

  private validateDependsOn(plan: InternalTaskPlan): void {
    try {
      validateTaskGraph(
        plan.steps.map((s) => ({
          id: s.stepId,
          title: s.title,
          description: s.description ?? "",
          requiredPermissions: s.requiredPermissions,
          needsConfirmation: s.requiresApproval ?? false,
          dependsOn: s.dependsOn,
          requiredContext: [],
          availableTools: s.toolName ? [s.toolName] : [],
          expectedArtifacts: s.expectedOutput ? [s.expectedOutput] : [],
          priority: s.priority,
          status: "pending" as const,
        })),
      );
    } catch (error) {
      throw new PlanValidationError("INVALID_DEPENDS_ON", String(error));
    }
  }

  private validateTools(plan: InternalTaskPlan): void {
    for (const step of plan.steps) {
      if (step.type !== "tool_call" || !step.toolName) continue;
      if (!this.options.registry.get(step.toolName)) {
        throw new PlanValidationError("UNKNOWN_TOOL", `未知工具：${step.toolName}`);
      }
    }
  }

  private validatePaths(plan: InternalTaskPlan): void {
    const forbidden = new Set(plan.guards.forbiddenPaths.map(normalizePath));
    for (const step of plan.steps) {
      const path = step.args?.path;
      if (typeof path !== "string") continue;
      const norm = normalizePath(path);
      for (const f of forbidden) {
        if (norm === f || norm.startsWith(`${f}/`) || norm.includes(`/${f}/`)) {
          throw new PlanValidationError("FORBIDDEN_PATH", `步骤 ${step.stepId} 路径被禁止：${path}`);
        }
      }
    }
  }

  private validateBudget(plan: InternalTaskPlan): void {
    if (plan.steps.length > plan.budget.maxSteps) {
      throw new PlanValidationError("BUDGET_EXCEEDED", "步骤数超过 maxSteps");
    }
    const toolCalls = plan.steps.filter((s) => s.type === "tool_call").length;
    if (toolCalls > plan.budget.maxToolCalls) {
      throw new PlanValidationError("BUDGET_EXCEEDED", "工具调用步骤超过 maxToolCalls");
    }
  }

  private validateRiskApproval(plan: InternalTaskPlan): void {
    for (const step of plan.steps) {
      if (step.riskLevel === "high" && step.requiresApproval !== true) {
        throw new PlanValidationError(
          "INVALID_SCHEMA",
          `高风险步骤必须 requiresApproval=true：${step.stepId}`,
        );
      }
    }
    const hasWrite = plan.steps.some((s) => s.requiredPermissions.includes("write"));
    if (hasWrite && plan.rollback.strategy === "none") {
      throw new PlanValidationError("INVALID_SCHEMA", "写操作计划必须声明 rollback strategy");
    }
  }

  private validateHash(plan: InternalTaskPlan, expectedHash?: string): void {
    const hash = computePlanHash(plan);
    if (plan.audit.planHash && plan.audit.planHash !== hash) {
      throw new PlanValidationError("PLAN_HASH_MISMATCH", "planHash 与内容不一致");
    }
    if (expectedHash && expectedHash !== hash && expectedHash !== plan.audit.planHash) {
      throw new PlanValidationError("PLAN_HASH_MISMATCH", "planHash 校验失败");
    }
  }
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function canTransition(from: PlanStatus, to: PlanStatus): boolean {
  const allowed: Record<PlanStatus, PlanStatus[]> = {
    draft: ["validated", "cancelled", "superseded"],
    validated: ["awaiting_approval", "approved", "cancelled", "superseded"],
    awaiting_approval: ["approved", "rejected", "cancelled", "superseded"],
    approved: ["scheduled", "running", "cancelled", "superseded"],
    scheduled: ["running", "cancelled"],
    running: ["completed", "failed", "paused", "rollback_required", "cancelled"],
    completed: [],
    rejected: ["superseded"],
    cancelled: [],
    failed: ["rollback_required", "superseded"],
    paused: ["running", "cancelled"],
    superseded: [],
    rollback_required: ["rolled_back", "failed"],
    rolled_back: [],
  };
  return allowed[from]?.includes(to) ?? false;
}

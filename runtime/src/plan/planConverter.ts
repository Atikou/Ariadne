import { validateTaskGraph } from "../agent/taskGraph.js";
import { requiresConfirmation, type ToolPermission } from "../core/permissions.js";
import type { Plan, PlanStep } from "../agent/types.js";
import { attachPlanHash } from "./planHash.js";
import {
  PLAN_SCHEMA_VERSION,
  type InternalPlanStep,
  type InternalStepType,
  type InternalTaskPlan,
  type PlanMode,
  type RiskLevel,
} from "./types.js";

const DEFAULT_FORBIDDEN = [".env", "node_modules", ".git"];

export interface BuildInternalPlanOptions {
  planId: string;
  version: number;
  workspaceRoot: string;
  sessionId?: string;
  requestId?: string;
  mode?: PlanMode;
  originType?: InternalTaskPlan["origin"]["type"];
  status?: InternalTaskPlan["status"];
}

function inferRiskLevel(permissions: ToolPermission[]): RiskLevel {
  if (permissions.includes("dangerous") || permissions.includes("shell")) return "high";
  if (permissions.includes("write") || permissions.includes("network")) return "medium";
  return "low";
}

function inferStepType(step: PlanStep): InternalStepType {
  if (step.tool) return "tool_call";
  return "manual";
}

function collectPaths(steps: PlanStep[]): { readSet: string[]; writeSet: string[] } {
  const readSet = new Set<string>();
  const writeSet = new Set<string>();
  for (const step of steps) {
    const path = step.toolInput?.path;
    if (typeof path !== "string") continue;
    if (step.tool === "write_file" || step.tool === "apply_patch") writeSet.add(path);
    else readSet.add(path);
  }
  return { readSet: [...readSet], writeSet: [...writeSet] };
}

function toInternalStep(step: PlanStep): InternalPlanStep {
  const perms = step.requiredPermissions as ToolPermission[];
  const riskLevel = inferRiskLevel(perms);
  const needsApproval =
    step.needsConfirmation === true || requiresConfirmation(perms) || riskLevel === "high";
  return {
    stepId: step.id,
    type: inferStepType(step),
    title: step.title,
    description: step.description,
    objective: step.objective,
    toolName: step.tool,
    args: step.toolInput,
    dependsOn: step.dependsOn ?? [],
    riskLevel,
    expectedOutput: step.expectedArtifacts?.[0] ?? step.acceptance,
    requiresApproval: needsApproval,
    requiredPermissions: perms,
    priority: step.priority ?? 100,
  };
}

/** 将 Planner 产出的 legacy `Plan` 转为 `ExecutableTaskPlan`（唯一可执行形态）。 */
export function internalPlanFromLegacy(plan: Plan, options: BuildInternalPlanOptions): InternalTaskPlan {
  validateTaskGraph(plan.steps);
  const paths = collectPaths(plan.steps);
  const now = new Date().toISOString();
  const shellSteps = plan.steps.filter(
    (s) => s.requiredPermissions.includes("shell") || s.requiredPermissions.includes("dangerous"),
  ).length;
  const writeSteps = plan.steps.filter((s) => s.requiredPermissions.includes("write")).length;

  const draft: InternalTaskPlan = {
    kind: "internal_task_plan",
    schemaVersion: PLAN_SCHEMA_VERSION,
    planId: options.planId,
    version: options.version,
    status: options.status ?? "draft",
    origin: {
      type: options.originType ?? "planner",
      sessionId: options.sessionId,
      requestId: options.requestId,
    },
    goal: plan.goal,
    mode: options.mode ?? "implement",
    scope: {
      workspaceRoot: options.workspaceRoot,
      sessionId: options.sessionId,
    },
    inputs: plan.inputs ?? [],
    outputs: plan.outputs ?? [],
    acceptanceCriteria: plan.acceptanceCriteria ?? [],
    scopeDetail: plan.scope ?? { inScope: [], outOfScope: [] },
    budget: {
      maxSteps: Math.max(plan.steps.length * 2, 20),
      maxToolCalls: Math.max(plan.steps.length * 2, 15),
      maxWriteCalls: Math.max(writeSteps + 2, 5),
      maxShellCalls: Math.max(shellSteps + 1, 2),
    },
    permissions: {
      allowWrite: plan.steps.some((s) => s.requiredPermissions.includes("write")),
      allowShell: plan.steps.some((s) => s.requiredPermissions.includes("shell")),
      allowDangerousShell: plan.steps.some((s) => s.requiredPermissions.includes("dangerous")),
      requireApprovalBeforeWrite: true,
    },
    steps: plan.steps.map(toInternalStep),
    guards: {
      requiredCleanGitStatus: false,
      readSet: paths.readSet,
      writeSet: paths.writeSet,
      forbiddenPaths: DEFAULT_FORBIDDEN,
    },
    rollback: {
      strategy: "backup_and_patch",
      createBackupBeforeWrite: true,
    },
    audit: {
      createdAt: now,
      createdBy: "agent",
      planHash: "",
    },
  };
  return attachPlanHash(draft);
}

/** TaskRunner 边界：从 `ExecutableTaskPlan` 生成 legacy `Plan`（单点转换，避免散落垫片）。 */
export function toTaskRunnerPlan(internal: InternalTaskPlan): Plan {
  return legacyPlanFromInternal(internal);
}

/**
 * @deprecated 请使用 `toTaskRunnerPlan`。
 */
export function legacyPlanFromInternal(internal: InternalTaskPlan): Plan {
  return {
    goal: internal.goal,
    scope: internal.scopeDetail,
    inputs: internal.inputs,
    outputs: internal.outputs,
    acceptanceCriteria: internal.acceptanceCriteria,
    risks: [],
    dependencies: [],
    steps: internal.steps.map((s) => ({
      id: s.stepId,
      title: s.title,
      objective: s.objective ?? s.title,
      description: s.description ?? "",
      requiredPermissions: s.requiredPermissions,
      needsConfirmation: s.requiresApproval ?? false,
      acceptance: s.expectedOutput,
      dependsOn: s.dependsOn,
      requiredContext: [],
      availableTools: s.toolName ? [s.toolName] : [],
      expectedArtifacts: s.expectedOutput ? [s.expectedOutput] : [],
      priority: s.priority,
      tool: s.toolName,
      toolInput: s.args,
      status: "pending",
    })),
  };
}

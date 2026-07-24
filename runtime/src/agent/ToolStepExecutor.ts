import { MODE_PERMISSIONS } from "../core/permissions.js";
import type { ToolPermission } from "../core/permissions.js";
import { resolveEffectivePermissions } from "../policy/PermissionPolicy.js";
import { StepExecutionError, type StepContext, type StepExecutor, type StepResult } from "./TaskRunner.js";
import type { PlanStep } from "./types.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { BudgetManager } from "./BudgetManager.js";
import {
  ToolExecutionGateway,
  defaultWorkflowRouteForTaskTool,
  type BudgetBucket,
} from "./ToolExecutionGateway.js";

export interface ToolStepExecutorOptions {
  registry: ToolRegistry;
  workspaceRoot: string;
  taskId?: string;
  sessionId?: string;
  projectId?: string;
  requestId?: string;
  allowedPermissions?: ToolPermission[];
  /** Trusted server grant for internal static execution; never sourced from an HTTP body. */
  runGrantedPermissions?: readonly ToolPermission[];
  projectAllowedPermissions?: ToolPermission[];
  /** 为 true 时，无 tool 绑定的步骤直接失败，禁止 no-op 跳过。 */
  requireToolBinding?: boolean;
  permissionPolicy?: import("./RunPolicyTypes.js").UserPermissionPolicy;
  budgetBucket?: BudgetBucket;
  budgetManager?: BudgetManager;
  existingSteps?: import("./toolStep.js").AgentToolStep[];
}

/**
 * 工具驱动的步骤执行器：经 ToolExecutionGateway 执行计划步骤。
 */
export class ToolStepExecutor implements StepExecutor {
  private readonly allowed: ToolPermission[];
  private readonly gateway: ToolExecutionGateway;

  constructor(private readonly options: ToolStepExecutorOptions) {
    const resolved = resolveEffectivePermissions({
      projectAllowed: options.projectAllowedPermissions,
      modeAllowed: MODE_PERMISSIONS.task,
      modeSource: "task.mode",
      taskAllowed: options.allowedPermissions,
      taskSource: "task.allowedPermissions",
    });
    this.allowed =
      resolved.allowed.length > 0
        ? resolved.allowed
        : (options.allowedPermissions ?? MODE_PERMISSIONS.task);
    this.gateway = new ToolExecutionGateway(options.registry);
  }

  async execute(step: PlanStep, ctx: StepContext): Promise<StepResult> {
    if (!step.tool) {
      if (this.options.requireToolBinding) {
        throw new StepExecutionError(`步骤 ${step.id} 缺少 tool 绑定，无法执行`);
      }
      return { output: `（无绑定工具，跳过实际执行）${step.title}` };
    }

    const toolCallId = this.makeToolCallId(step);
    const tool = this.options.registry.get(step.tool);
    const workflowRoute = defaultWorkflowRouteForTaskTool(tool?.permission);

    const result = await this.gateway.run({
      toolName: step.tool,
      input: (step.toolInput ?? {}) as Record<string, unknown>,
      toolCallId,
      source: "task_runner",
      budgetBucket: this.options.budgetBucket ?? "main",
      workspaceRoot: this.options.workspaceRoot,
      projectId: this.options.projectId,
      taskId: this.options.taskId,
      sessionId: this.options.sessionId,
      requestId: this.options.requestId,
      signal: ctx.signal,
      allowedPermissions: this.allowed,
      runGrantedPermissions: this.options.runGrantedPermissions,
      intent: tool?.permission === "shell" ? "run" : tool?.permission === "write" ? "edit" : "answer",
      permissionPolicy: this.options.permissionPolicy ?? "confirmBeforeRun",
      mode: "implement",
      workflowRoute,
      budgetManager: this.options.budgetManager,
      existingSteps: this.options.existingSteps,
    });

    if (result.outcomeClass === "execution_error") {
      throw new StepExecutionError(
        `[${result.tool}] ${result.code}/${result.category}: ${result.error ?? result.message}`,
        result.toolCallId,
      );
    }
    return { output: summarize(result.output), toolCallId: result.toolCallId };
  }

  private makeToolCallId(step: PlanStep): string {
    const prefix = this.options.requestId ?? this.options.taskId ?? this.options.sessionId ?? "task";
    return `${prefix}:step-${step.id}:${step.tool ?? "manual"}`;
  }
}

function summarize(output: unknown): string {
  const json = JSON.stringify(output);
  if (json.length <= 600) return json;
  return `${json.slice(0, 600)}…(已截断，共 ${json.length} 字符)`;
}

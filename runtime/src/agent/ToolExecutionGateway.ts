import path from "node:path";

import type { ToolPermission } from "../core/permissions.js";
import { evaluatePermissionGuard } from "../policy/PermissionGuard.js";
import type { ScopedApprovedPermissions } from "../policy/permissionRequestTypes.js";
import { PathPolicy, type ToolPathPreparation } from "../policy/PathPolicy.js";
import type { WorkspaceGrantStore, WorkspaceScopePermission } from "../policy/WorkspaceScopeManager.js";
import type { RegistryRunContext, ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolRunResult } from "../tools/types.js";
import type { BudgetManager } from "./BudgetManager.js";
import type { AgentIntentType } from "./IntentTypes.js";
import type { AgentRunMode, RunBudgetKey, UserPermissionPolicy } from "./RunPolicyTypes.js";
import type { AgentToolStep } from "./toolStep.js";
import {
  assessWorkflowToolAccess,
  type WorkflowCapabilityAssessment,
} from "./WorkflowCapability.js";
import type { WorkflowRouteResult } from "./WorkflowRouter.js";
import { defaultWorkflowRouter } from "./WorkflowRouter.js";

export type ToolExecutionSource =
  | "agent_loop"
  | "resume"
  | "preflight"
  | "task_runner"
  | "manual"
  | "rollback";

export type BudgetBucket =
  | "main"
  | "preflight"
  | "recovery"
  | "resume"
  | "manual"
  | "rollback";

export interface ToolExecutionContext {
  workspaceRoot: string;
  projectId?: string;
  sessionId?: string;
  taskId?: string;
  requestId?: string;
  signal?: AbortSignal;
  allowedPermissions: ToolPermission[];
  runGrantedPermissions?: readonly ToolPermission[];
  intent: AgentIntentType;
  permissionPolicy: UserPermissionPolicy;
  mode: AgentRunMode;
  workflowRoute: Pick<
    WorkflowRouteResult,
    "workflowKind" | "readonlyOnly" | "enforceReadOnlyTools" | "sideEffectKind"
  >;
  scopedGrants?: ScopedApprovedPermissions;
  /** 仅来自当前 permission request 的一次性、精确匹配授权。 */
  confirmedScopedGrants?: ScopedApprovedPermissions;
  workspaceGrantStore?: WorkspaceGrantStore;
  workspaceConfigScopes?: Array<{
    id: string;
    rootPath: string;
    label?: string;
    permissions?: WorkspaceScopePermission[];
  }>;
  budgetManager?: BudgetManager;
  existingSteps?: AgentToolStep[];
  isRecovery?: boolean;
  isPreflight?: boolean;
  shellPolicy?: import("../policy/ShellPolicy.js").ShellPolicy;
  networkPolicy?: import("../policy/NetworkPolicy.js").NetworkPolicy;
}

export interface ToolExecutionEvaluateInput extends ToolExecutionContext {
  toolName: string;
  input?: Record<string, unknown>;
  source: ToolExecutionSource;
  budgetBucket: BudgetBucket;
}

export interface ToolExecutionEvaluation {
  allowed: boolean;
  blocked: boolean;
  phase: "authorization" | "execution";
  blockReasonKind?: "workflow" | "permission" | "budget" | "policy";
  workflowBlock?: WorkflowCapabilityAssessment;
  permissionDecision?: ReturnType<typeof evaluatePermissionGuard>;
  budgetExhausted?: RunBudgetKey;
  pathAccess?: ToolPathPreparation;
  preparedInput?: Record<string, unknown>;
  reason?: string;
}

export interface ToolExecutionRunInput extends ToolExecutionEvaluateInput {
  toolCallId?: string;
  registryExtras?: Partial<RegistryRunContext>;
}

interface AuthorizedCall {
  input: ToolExecutionRunInput;
  preparedInput: Record<string, unknown>;
  pathAccess?: ToolPathPreparation;
  toolPermission: ToolPermission;
}

/**
 * 工具执行唯一入口。一次调用只能沿 authorize → applyBudget → execute 前进；
 * execute 消费内部许可，Registry 不会因重试或层间复核而被重复调用。
 */
export class ToolExecutionGateway {
  private readonly authorizations = new WeakMap<ToolExecutionEvaluation, AuthorizedCall>();
  private readonly executionPermits = new WeakMap<ToolExecutionEvaluation, AuthorizedCall>();

  constructor(private readonly registry: ToolRegistry) {}

  authorize(input: ToolExecutionRunInput): ToolExecutionEvaluation {
    const preparedInput = this.prepareToolInput(input.toolName, input.input ?? {});
    if (!input.intent || !input.permissionPolicy || !input.mode || !input.workflowRoute) {
      return blockedEvaluation(
        "authorization",
        "policy",
        "工具调用缺少 intent、permissionPolicy、mode 或 workflowRoute，拒绝执行",
        { preparedInput },
      );
    }
    const tool = this.registry.get(input.toolName);
    if (!tool) {
      return blockedEvaluation("authorization", "policy", `未知工具：${input.toolName}`, {
        preparedInput,
      });
    }

    const requiredPermissions = this.registry.resolveRequiredPermissions(input.toolName, preparedInput);
    const toolPermission = this.registry.resolvePrimaryPermission(input.toolName, preparedInput) ?? tool.permission;

    const workflowBlock = requiredPermissions
      .map((permission) => assessWorkflowToolAccess({
        mode: input.mode,
        workflowRoute: input.workflowRoute,
        toolPermission: permission,
      }))
      .find((assessment) => assessment.blocked);
    if (workflowBlock?.blocked) {
      return blockedEvaluation(
        "authorization",
        "workflow",
        workflowBlock.reason ?? "工作流不允许该工具权限",
        { workflowBlock, preparedInput },
      );
    }

    const pathPolicy = new PathPolicy({
      primaryRoot: input.workspaceRoot,
      grants: input.workspaceGrantStore,
      configScopes: input.workspaceConfigScopes,
    });
    const pathAccess = pathPolicy.prepareTool(input.toolName, preparedInput, {
      sessionId: input.sessionId,
      projectId: input.projectId,
      taskId: input.taskId,
      scopedGrants: input.scopedGrants,
    });
    if (pathAccess && !pathAccess.decision.allowed) {
      return blockedEvaluation(
        "authorization",
        pathAccess.decision.needsConfirmation ? "permission" : "policy",
        pathAccess.decision.needsConfirmation
          ? `跨工作区访问需要用户授权：${pathAccess.decision.normalizedPath}`
          : `路径策略拒绝访问：${pathAccess.decision.reason}`,
        { pathAccess, preparedInput },
      );
    }

    const permissionDecision = requiredPermissions
      .map((permission) => evaluatePermissionGuard({
        intent: input.intent,
        permissionPolicy: input.permissionPolicy,
        toolName: tool.name,
        permission,
        input: preparedInput,
        allowedPermissions: input.allowedPermissions,
        runGrantedPermissions: input.runGrantedPermissions,
        scopedGrants: input.scopedGrants,
        confirmedScopedGrants: input.confirmedScopedGrants,
        shellPolicy: input.shellPolicy,
        networkPolicy: input.networkPolicy,
      }))
      .find((decision) => decision.decision !== "allow");
    if (permissionDecision) {
      return blockedEvaluation(
        "authorization",
        "permission",
        permissionDecision.reason ??
          (permissionDecision.decision === "deny"
            ? "权限拒绝"
            : `工具「${tool.name}」需要用户确认`),
        { permissionDecision, pathAccess, preparedInput },
      );
    }

    const evaluation: ToolExecutionEvaluation = {
      allowed: true,
      blocked: false,
      phase: "authorization",
      pathAccess,
      preparedInput: pathAccess?.input ?? preparedInput,
    };
    this.authorizations.set(evaluation, {
      input: { ...input, input: preparedInput },
      preparedInput: pathAccess?.input ?? preparedInput,
      pathAccess,
      toolPermission,
    });
    return evaluation;
  }

  applyBudget(authorization: ToolExecutionEvaluation): ToolExecutionEvaluation {
    if (authorization.blocked) return authorization;
    const call = this.authorizations.get(authorization);
    if (!call) {
      return blockedEvaluation(
        "execution",
        "policy",
        "工具授权决策无效、已过期或不属于当前执行网关",
      );
    }
    this.authorizations.delete(authorization);

    const { input } = call;
    const tool = this.registry.get(input.toolName);
    if (!tool) {
      return blockedEvaluation("execution", "policy", `未知工具：${input.toolName}`);
    }
    if (input.budgetManager) {
      const budgetExhausted = input.budgetManager.findToolExhaustion({
        toolPermission: call.toolPermission,
        permissionAllowed: input.allowedPermissions.includes(call.toolPermission),
        steps: input.existingSteps ?? [],
        isRecovery: input.isRecovery ?? input.budgetBucket === "recovery",
        isPreflight: input.isPreflight ?? input.budgetBucket === "preflight",
      });
      if (budgetExhausted) {
        return blockedEvaluation(
          "execution",
          "budget",
          `运行预算已耗尽：${budgetExhausted}`,
          {
            budgetExhausted,
            pathAccess: call.pathAccess,
            preparedInput: call.preparedInput,
          },
        );
      }
    }

    const evaluation: ToolExecutionEvaluation = {
      allowed: true,
      blocked: false,
      phase: "execution",
      pathAccess: call.pathAccess,
      preparedInput: call.preparedInput,
    };
    this.executionPermits.set(evaluation, call);
    return evaluation;
  }

  evaluate(input: ToolExecutionRunInput): ToolExecutionEvaluation {
    return this.applyBudget(this.authorize(input));
  }

  async execute(evaluation: ToolExecutionEvaluation): Promise<ToolRunResult> {
    if (evaluation.blocked) {
      return blockedToolRunResult("unknown", evaluation);
    }
    const call = this.executionPermits.get(evaluation);
    if (!call) {
      return blockedToolRunResult(
        "unknown",
        blockedEvaluation(
          "execution",
          "policy",
          "工具执行许可无效、已消费或不属于当前执行网关",
        ),
      );
    }
    this.executionPermits.delete(evaluation);

    const { input, pathAccess, preparedInput } = call;
    if (input.budgetManager) {
      if (input.budgetBucket === "preflight" || input.isPreflight) {
        input.budgetManager.recordPreflightTool();
      } else if (input.budgetBucket === "recovery" || input.isRecovery) {
        input.budgetManager.recordRecoveryTurn();
      }
    }

    return this.registry.run(input.toolName, preparedInput, {
      workspaceRoot: pathAccess?.workspaceRoot ?? input.workspaceRoot,
      taskId: input.taskId,
      sessionId: input.sessionId,
      requestId: input.requestId,
      toolCallId: input.toolCallId,
      signal: input.signal,
      allowedPermissions: input.allowedPermissions,
      workspaceAccess: pathAccess?.audit as unknown as Record<string, unknown> | undefined,
      ...input.registryExtras,
    });
  }

  async run(input: ToolExecutionRunInput): Promise<ToolRunResult> {
    const evaluation = this.evaluate(input);
    if (evaluation.blocked) return blockedToolRunResult(input.toolName, evaluation);
    return this.execute(evaluation);
  }

  private prepareToolInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
    if (toolName !== "rollback_change") return input;
    const changeId = input.changeId;
    if (typeof changeId !== "string" || !changeId.trim()) return input;
    const change = this.registry.getStorage()?.getFileChange(changeId);
    if (!change) return input;
    const rollbackPath =
      change.normalizedPath ??
      (change.workspaceRoot ? path.resolve(change.workspaceRoot, change.path) : change.path);
    return {
      ...input,
      path: rollbackPath,
      rollbackWorkspaceRoot: change.workspaceRoot,
      rollbackNormalizedPath: change.normalizedPath,
    };
  }
}

export function defaultWorkflowRouteForTaskTool(
  toolPermission?: ToolPermission,
): Pick<WorkflowRouteResult, "workflowKind" | "readonlyOnly" | "enforceReadOnlyTools" | "sideEffectKind"> {
  if (toolPermission === "shell") return defaultWorkflowRouter.routeIntent("run");
  if (toolPermission === "write" || toolPermission === "dangerous") {
    return defaultWorkflowRouter.routeIntent("edit");
  }
  return defaultWorkflowRouter.routeIntent("answer");
}

function blockedEvaluation(
  phase: ToolExecutionEvaluation["phase"],
  blockReasonKind: NonNullable<ToolExecutionEvaluation["blockReasonKind"]>,
  reason: string,
  extras: Partial<ToolExecutionEvaluation> = {},
): ToolExecutionEvaluation {
  return {
    allowed: false,
    blocked: true,
    phase,
    blockReasonKind,
    reason,
    ...extras,
  };
}

function blockedToolRunResult(tool: string, evaluation: ToolExecutionEvaluation): ToolRunResult {
  const isPermission = evaluation.blockReasonKind === "permission";
  const isPolicy = evaluation.blockReasonKind === "policy";
  const needsPathConfirmation = evaluation.pathAccess?.decision.needsConfirmation === true;
  const needsPermissionConfirmation =
    needsPathConfirmation || evaluation.permissionDecision?.decision === "needsConfirmation";
  return {
    tool,
    durationMs: 0,
    executed: false,
    outcomeClass: "execution_error",
    outcomeKind: needsPermissionConfirmation
      ? "permission_required"
      : isPermission
        ? "permission_denied"
        : isPolicy
          ? "policy_blocked"
          : evaluation.blockReasonKind ?? "blocked",
    message: evaluation.reason ?? "工具执行被阻止",
    recoverable: evaluation.blockReasonKind === "budget" || needsPermissionConfirmation,
    requiresUserAction: needsPermissionConfirmation,
    ok: false,
    code: isPermission ? "permission_denied" : undefined,
    category: isPermission ? "permission_error" : "user_error",
    error: evaluation.reason,
    risk: evaluation.permissionDecision?.risk,
  };
}

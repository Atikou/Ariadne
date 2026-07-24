import { resolveAllowedPermissions } from "./WorkflowCapability.js";
import { BudgetManager } from "./BudgetManager.js";
import { defaultWorkflowRouter } from "./WorkflowRouter.js";
import { EntryIntentRouter } from "./routing/EntryIntentRouter.js";
import { afterPlanForVariant } from "./planExecutionVariant.js";
import {
  buildRunPolicySystemHint,
  executionStageForIntent,
  inferRunPermissionPolicy,
  resolvePlanVariantForIntent,
} from "./RunPolicyPresentation.js";
import {
  MODE_BASE_BUDGETS,
  MODE_SUGGESTED_BUDGETS,
  mergeBudgetMax,
  mergeRunBudget,
} from "./runBudgetDefaults.js";
import {
  parseRunModeValue,
  parseUserPermissionPolicyValue,
  type AgentRunMode,
  type ResolveRunPolicyInput,
  type RunBudget,
  type RunPolicy,
  type UserPermissionPolicy,
} from "./RunPolicyTypes.js";

/** 解析运行模式、分项预算与权限策略；与 `BudgetManager` 配对使用。 */
export class RunPolicyManager {
  constructor(private readonly entryIntentRouter: EntryIntentRouter = new EntryIntentRouter()) {}

  resolve(input: ResolveRunPolicyInput = {}): RunPolicy {
    return this.buildPolicy(input, this.entryIntentRouter.resolve({
      requestedMode: input.requestedMode,
      forceRequestedMode: input.forceMode === true,
      message: input.message,
      taskType: input.taskType,
      sessionId: input.sessionId,
    }));
  }

  async resolveAsync(input: ResolveRunPolicyInput = {}): Promise<RunPolicy> {
    const decision = await this.entryIntentRouter.resolveAsync({
      requestedMode: input.requestedMode,
      forceRequestedMode: input.forceMode === true,
      message: input.message,
      taskType: input.taskType,
      sessionId: input.sessionId,
    });
    return this.buildPolicy(input, decision);
  }

  private buildPolicy(input: ResolveRunPolicyInput, decision: import("./routing/IntentDecision.js").IntentDecision): RunPolicy {
    const mode = decision.mode;
    const budget = this.resolveBudget(mode, input.budget);
    const suggestedBudget = mergeBudgetMax(MODE_SUGGESTED_BUDGETS[mode], budget);
    const explicitPermissionPolicy = parseUserPermissionPolicyValue(input.requestedPermissionPolicy);
    const permissionPolicy = explicitPermissionPolicy ?? inferRunPermissionPolicy({
      mode,
      intent: decision.intent,
      autoConfirm: input.autoConfirm === true,
    });
    const decisionWorkflowRoute = defaultWorkflowRouter.routeWorkflowType(decision.workflowType);
    const workflowRoute =
      decisionWorkflowRoute?.intent === decision.intent
        ? decisionWorkflowRoute
        : defaultWorkflowRouter.routeIntent(decision.intent);
    const allowedPermissions = resolveAllowedPermissions(workflowRoute, permissionPolicy);

    const planVariant = resolvePlanVariantForIntent(decision.intent, input.message);
    const afterPlan = afterPlanForVariant(planVariant);

    return {
      mode,
      executionStage: executionStageForIntent(decision.intent),
      modeSource: decision.modeSource,
      intent: decision.intent,
      workflowType: workflowRoute.workflowType,
      permissionPolicy,
      permissionPolicySource: explicitPermissionPolicy ? "explicit" : "inferred",
      planVariant,
      afterPlan,
      budget,
      allowedPermissions,
      requireFinalAnswer: true,
      allowPartialAnswer: true,
      suggestedBudget,
      systemHint: buildRunPolicySystemHint(mode),
      intentDecisionSource: decision.source,
      isContinuation: decision.isContinuation,
      intentDecisionReason: decision.reason,
      intentDecisionConfidence: decision.confidence,
      inheritedTaskId: decision.inheritedTaskId,
      previousWorkflowType: decision.previousWorkflowType,
      continuationScore: decision.continuationScore,
      continuationSignals: decision.continuationSignals,
      needsWrite: decision.needsWrite,
      needsShell: decision.needsRunCommand,
      requiredSideEffects: decision.requiredSideEffects ?? [
        ...(decision.needsWrite ? (["write"] as const) : []),
        ...(decision.needsRunCommand ? (["shell"] as const) : []),
      ],
      aiOverridden: decision.aiOverridden,
      boundaryBreakReason: decision.boundaryBreakReason,
      effectiveTaskContextId: decision.effectiveTaskContextId,
      legacyIntentHint: decision.legacyIntentHint,
      legacyHintSources: decision.legacyHintSources,
      entryIntent: decision.intent,
      entryWorkflowType: workflowRoute.workflowType,
      effectiveWorkflowType: workflowRoute.workflowType,
    };
  }

  parseMode(mode: string | undefined): AgentRunMode | undefined {
    return parseRunModeValue(mode);
  }

  parsePermissionPolicy(policy: string | undefined): UserPermissionPolicy | undefined {
    return parseUserPermissionPolicyValue(policy);
  }

  inferMode(input: ResolveRunPolicyInput): AgentRunMode {
    return this.entryIntentRouter.resolve({
      message: input.message,
      taskType: input.taskType,
      sessionId: input.sessionId,
      requestedMode: input.requestedMode,
      forceRequestedMode: input.forceMode === true,
    }).mode;
  }

  resolveBudget(mode: AgentRunMode, override: Partial<RunBudget> | undefined): RunBudget {
    return mergeRunBudget(MODE_BASE_BUDGETS[mode], override);
  }

  createBudgetManager(policy: RunPolicy): BudgetManager {
    return new BudgetManager(policy.budget, policy.suggestedBudget);
  }
}

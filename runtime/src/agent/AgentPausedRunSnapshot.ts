import type { ChatMessage } from "../model/types.js";
import {
  permissionItemsFromConfirmation,
  type PermissionRequestStore,
} from "../policy/PermissionRequestStore.js";
import type { PermissionRequestPayload } from "../policy/permissionRequestTypes.js";
import type { BudgetManager } from "./BudgetManager.js";
import type { CapabilityEscalationRecord } from "./CapabilityEscalation.js";
import type { AgentIntentType, AgentWorkflowType } from "./IntentTypes.js";
import type {
  AgentHandoffAuthorizationContext,
  PendingToolAction,
  PausedRunRuntimeState,
  PausedRunSnapshot,
} from "./PausedRunStore.js";
import type { ToolPermission } from "../core/permissions.js";
import type { FailedActionMemory } from "./recovery/FailedActionMemory.js";
import type { RunToolResultCache } from "./recovery/RunToolResultCache.js";
import type {
  AgentExecutionStage,
  AgentRunMode,
  AgentWorkflowDebugAnalysis,
  AgentWorkflowInternalPlan,
  AgentWorkflowProposal,
  AgentWorkflowRefactorPlan,
  PlanExecutionVariant,
  UserPermissionPolicy,
} from "./RunPolicyTypes.js";
import type { AgentToolStep } from "./toolStep.js";
import type { CompletionCriterionInput } from "./completion/TaskCompletionContract.js";
import type { AgentPlanContract } from "../plan/AgentPlanContract.js";

export interface BuildPausedRunRuntimeStateInput {
  entryIntent?: AgentIntentType;
  entryWorkflowType?: AgentWorkflowType;
  reconciledIntent?: AgentIntentType;
  reconciledWorkflowType?: AgentWorkflowType;
  capabilityEscalations: CapabilityEscalationRecord[];
  budgetManager: BudgetManager;
  failedActionMemory: FailedActionMemory;
  toolResultCache: RunToolResultCache;
}

/** 从当前 Run 运行时收集可恢复的暂停快照状态。 */
export function buildPausedRunRuntimeState(
  input: BuildPausedRunRuntimeStateInput,
): PausedRunRuntimeState {
  return {
    entryIntent: input.entryIntent,
    entryWorkflowType: input.entryWorkflowType,
    reconciledIntent: input.reconciledIntent,
    reconciledWorkflowType: input.reconciledWorkflowType,
    capabilityEscalations: [...input.capabilityEscalations],
    budgetLedger: input.budgetManager.ledgerSnapshot(),
    failedActionMemoryState: input.failedActionMemory.exportState(),
    toolCacheEntries: input.toolResultCache.exportState(),
  };
}

export interface PausedRunRuntimeRestoreTarget {
  capabilityEscalations: CapabilityEscalationRecord[];
  failedActionMemory: FailedActionMemory;
  toolResultCache: RunToolResultCache;
  budgetManager: BudgetManager;
}

/** 从暂停快照恢复 escalation / 预算 / 缓存 / 熔断状态（entry/reconciled 由调用方赋值）。 */
export function restorePausedRunRuntimeState(
  target: PausedRunRuntimeRestoreTarget,
  state?: PausedRunRuntimeState,
): void {
  if (!state) return;
  target.capabilityEscalations.splice(
    0,
    target.capabilityEscalations.length,
    ...(state.capabilityEscalations ?? []),
  );
  if (state.failedActionMemoryState?.length) {
    target.failedActionMemory.restoreState(state.failedActionMemoryState);
  }
  if (state.toolCacheEntries?.length) {
    target.toolResultCache.restoreState(state.toolCacheEntries);
  }
  if (state.budgetLedger) {
    target.budgetManager.restoreLedger(state.budgetLedger);
  }
}

export interface BuildPausedRunSnapshotInput {
  runId: string;
  sessionId?: string;
  goal: string;
  system?: string;
  messages: ChatMessage[];
  steps: AgentToolStep[];
  modelTurns: number;
  pendingAction?: PendingToolAction;
  mode: AgentRunMode;
  permissionPolicy: UserPermissionPolicy;
  permissionCeiling?: ToolPermission[];
  runGrantedPermissions?: ToolPermission[];
  handoffAuthorization?: AgentHandoffAuthorizationContext;
  resumeMode?: AgentRunMode;
  approvedPlan?: AgentPlanContract;
  runtimeState: PausedRunRuntimeState;
  workflowProposals?: AgentWorkflowProposal[];
  workflowDebugAnalyses?: AgentWorkflowDebugAnalysis[];
  workflowRefactorPlans?: AgentWorkflowRefactorPlan[];
  workflowInternalPlans?: AgentWorkflowInternalPlan[];
  completionCriteria?: CompletionCriterionInput[];
  createdAt?: string;
}

/** 构建可写入 PausedRunStore 的快照（深拷贝 messages / steps / 工作流产物）。 */
export function buildPausedRunSnapshot(input: BuildPausedRunSnapshotInput): PausedRunSnapshot {
  return {
    execution: {
      engineKind: "react_loop",
      schemaVersion: 1,
    },
    runId: input.runId,
    sessionId: input.sessionId,
    goal: input.goal,
    system: input.system,
    messages: input.messages.map((m) => ({ ...m })),
    steps: [...input.steps],
    workflowProposals: input.workflowProposals ? [...input.workflowProposals] : undefined,
    workflowDebugAnalyses: input.workflowDebugAnalyses ? [...input.workflowDebugAnalyses] : undefined,
    workflowRefactorPlans: input.workflowRefactorPlans ? [...input.workflowRefactorPlans] : undefined,
    workflowInternalPlans: input.workflowInternalPlans ? [...input.workflowInternalPlans] : undefined,
    completionCriteria: input.completionCriteria?.map((criterion) => ({
      ...criterion,
      toolNames: criterion.toolNames ? [...criterion.toolNames] : undefined,
      expectedInputSubset: criterion.expectedInputSubset
        ? structuredClone(criterion.expectedInputSubset)
        : undefined,
    })),
    modelTurns: input.modelTurns,
    pendingAction: input.pendingAction,
    mode: input.mode,
    permissionPolicy: input.permissionPolicy,
    permissionCeiling: input.permissionCeiling ? [...input.permissionCeiling] : undefined,
    runGrantedPermissions: input.runGrantedPermissions ? [...input.runGrantedPermissions] : undefined,
    handoffAuthorization: input.handoffAuthorization
      ? { ...input.handoffAuthorization }
      : undefined,
    resumeMode: input.resumeMode,
    approvedPlan: input.approvedPlan ? structuredClone(input.approvedPlan) : undefined,
    runtimeState: input.runtimeState,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export interface CreateJitPermissionRequestInput {
  permissionRequestStore: PermissionRequestStore;
  step: AgentToolStep;
  runId: string;
  sessionId?: string;
  projectId?: string;
  intent: AgentIntentType;
  executionStage: AgentExecutionStage;
  planVariant?: PlanExecutionVariant;
}

/** 从被阻塞的工具步骤创建 JIT 权限申请（与 planHandoff 分离）。 */
export function createJitPermissionRequestFromStep(
  input: CreateJitPermissionRequestInput,
): PermissionRequestPayload {
  const confirmation = input.step.confirmationRequest!;
  const requiredPermissions = permissionItemsFromConfirmation(confirmation);
  return input.permissionRequestStore.create({
    runId: input.runId,
    sessionId: input.sessionId,
    projectId: input.projectId,
    title: confirmation.title,
    summary: confirmation.message,
    requiredPermissions,
    intent: input.intent,
    executionStage: input.executionStage,
    planVariant: input.planVariant,
    blockedTool: {
      name: input.step.tool,
      input: input.step.input as Record<string, unknown> | undefined,
    },
  });
}

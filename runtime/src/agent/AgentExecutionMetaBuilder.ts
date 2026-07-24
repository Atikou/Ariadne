import type { BudgetManager } from "./BudgetManager.js";
import type { CompletionGuardResult } from "./completion/CompletionFinalGuard.js";
import { buildToolLedger, toolLedgerToSummary } from "./completion/ToolLedger.js";
import type { CapabilityEscalationRecord } from "./CapabilityEscalation.js";
import type { Finalizer } from "./Finalizer.js";
import type { AgentIntentType } from "./IntentTypes.js";
import { presentExecutionState } from "./presentation/ExecutionStatePresenter.js";
import {
  type AgentExecutionMeta,
  type AgentStopReason,
  type AgentWorkflowDebugAnalysis,
  type AgentWorkflowDebugFix,
  type AgentWorkflowInternalPlan,
  type AgentWorkflowProposal,
  type AgentWorkflowRefactorPlan,
  type AgentWorkflowSwitch,
  type AgentWorkflowWritePhase,
  type RunBudget,
  type RunBudgetKey,
  type RunPolicy,
} from "./RunPolicyTypes.js";
import type { AgentToolStep } from "./toolStep.js";
import { hasPlanningPhaseArtifacts, resolveWorkflowTaskState } from "./WorkflowTaskState.js";
import { buildWorkflowState } from "./WorkflowStateCenter.js";
import {
  buildLocationMeta,
  buildWorkflowCorrections,
  buildWorkflowDiffs,
  buildWorkflowVerifications,
} from "./workflowExecutionMeta.js";
import { MAX_WORKFLOW_CORRECTION_ATTEMPTS } from "./WorkflowCorrectionWorkflow.js";

export interface BuildAgentExecutionMetaInput {
  steps: AgentToolStep[];
  iterations: number;
  stopReason: AgentStopReason;
  budgetExhausted?: RunBudgetKey;
  goal: string;
  completionGuard?: CompletionGuardResult;
  partialSummary?: string;
  policy: RunPolicy;
  effectiveIntent: AgentIntentType;
  reconciledWorkflowType?: RunPolicy["workflowType"];
  reconciledIntent?: AgentIntentType;
  entryIntent?: RunPolicy["entryIntent"];
  entryWorkflowType?: RunPolicy["entryWorkflowType"];
  budget: RunBudget;
  budgetManager: BudgetManager;
  finalizer: Finalizer;
  workflowProposals: AgentWorkflowProposal[];
  workflowDebugAnalyses: AgentWorkflowDebugAnalysis[];
  workflowRefactorPlans: AgentWorkflowRefactorPlan[];
  workflowInternalPlans: AgentWorkflowInternalPlan[];
  workflowWritePhases: AgentWorkflowWritePhase[];
  workflowDebugFixes: AgentWorkflowDebugFix[];
  workflowSwitch?: AgentWorkflowSwitch;
  capabilityEscalations: CapabilityEscalationRecord[];
}

/** 从 Run 收尾上下文构建 `executionMeta`（含 userFacing 展示字段与预算耗尽 enrich）。 */
export function buildAgentExecutionMeta(input: BuildAgentExecutionMetaInput): AgentExecutionMeta {
  const usage = input.budgetManager.buildUsage(input.steps, input.iterations);
  const needsMoreBudget = input.stopReason === "budget_exhausted";
  const location = buildLocationMeta(input.steps);
  const workflowDiffs = buildWorkflowDiffs(input.steps);
  const workflowVerifications = buildWorkflowVerifications(input.effectiveIntent, input.steps);
  const workflowCorrections = buildWorkflowCorrections(input.effectiveIntent, input.steps);
  const workflowState = buildWorkflowState({
    intent: input.effectiveIntent,
    steps: input.steps,
    hasProposal: input.workflowProposals.length > 0,
    hasDebugAnalysis: input.workflowDebugAnalyses.length > 0,
    hasRefactorPlan: input.workflowRefactorPlans.length > 0,
    maxCorrectionAttempts: MAX_WORKFLOW_CORRECTION_ATTEMPTS,
  });
  const workflowTaskState = resolveWorkflowTaskState({
    stopReason: input.stopReason,
    steps: input.steps,
    hasPlanningPhase: hasPlanningPhaseArtifacts({
      workflowInternalPlans: input.workflowInternalPlans,
      workflowProposals: input.workflowProposals,
      workflowDebugAnalyses: input.workflowDebugAnalyses,
      workflowRefactorPlans: input.workflowRefactorPlans,
    }),
  });
  const ledger = buildToolLedger(input.steps);
  const workflowType = input.reconciledWorkflowType ?? input.policy.workflowType;
  const base: AgentExecutionMeta = {
    mode: input.policy.mode,
    executionStage: input.policy.executionStage,
    modeSource: input.policy.modeSource,
    intent: input.effectiveIntent,
    workflowType,
    permissionPolicy: input.policy.permissionPolicy,
    permissionPolicySource: input.policy.permissionPolicySource,
    intentDecisionSource: input.policy.intentDecisionSource,
    isContinuation: input.policy.isContinuation,
    intentDecisionReason: input.policy.intentDecisionReason,
    intentDecisionConfidence: input.policy.intentDecisionConfidence,
    inheritedTaskId: input.policy.inheritedTaskId,
    previousWorkflowType: input.policy.previousWorkflowType,
    currentWorkflowType: workflowType,
    continuationScore: input.policy.continuationScore,
    continuationSignals: input.policy.continuationSignals,
    needsWrite: input.policy.needsWrite,
    needsShell: input.policy.needsShell,
    requiredSideEffects: input.policy.requiredSideEffects,
    aiOverridden: input.policy.aiOverridden,
    boundaryBreakReason: input.policy.boundaryBreakReason,
    effectiveTaskContextId: input.policy.effectiveTaskContextId,
    legacyIntentHint: input.policy.legacyIntentHint,
    legacyHintSources: input.policy.legacyHintSources,
    entryIntent: input.entryIntent ?? input.policy.entryIntent,
    entryWorkflowType: input.entryWorkflowType ?? input.policy.entryWorkflowType,
    effectiveWorkflowType: input.reconciledWorkflowType ?? input.policy.effectiveWorkflowType,
    workflowProposals: input.workflowProposals.length ? input.workflowProposals : undefined,
    workflowDebugAnalyses: input.workflowDebugAnalyses.length ? input.workflowDebugAnalyses : undefined,
    workflowRefactorPlans: input.workflowRefactorPlans.length ? input.workflowRefactorPlans : undefined,
    workflowInternalPlans: input.workflowInternalPlans.length ? input.workflowInternalPlans : undefined,
    workflowTaskState,
    workflowSwitch: input.workflowSwitch,
    capabilityEscalations: input.capabilityEscalations.length
      ? input.capabilityEscalations
      : undefined,
    reconciledWorkflowType: input.reconciledWorkflowType,
    reconciledIntent: input.reconciledIntent,
    workflowState,
    workflowDiffs: workflowDiffs.length ? workflowDiffs : undefined,
    workflowVerifications: workflowVerifications.length ? workflowVerifications : undefined,
    workflowCorrections: workflowCorrections.length ? workflowCorrections : undefined,
    workflowWritePhases: input.workflowWritePhases.length ? input.workflowWritePhases : undefined,
    workflowDebugFixes: input.workflowDebugFixes.length ? input.workflowDebugFixes : undefined,
    budget: input.budget,
    usage,
    budgetExhausted: input.budgetExhausted,
    usedIterations: input.iterations,
    usedModelTurns: input.iterations,
    usedToolCalls: usage.toolCalls,
    usedReadCalls: usage.readCalls,
    usedWriteCalls: usage.writeCalls,
    usedShellCalls: usage.shellCalls,
    stopReason: input.stopReason,
    needsMoreBudget,
    location,
    completionStatus: input.completionGuard?.status,
    completionGuardReason: input.completionGuard?.reason,
    completionContract: input.completionGuard?.contract,
    completionEvidence: input.completionGuard?.evidence,
    guardedAnswer: input.completionGuard?.guardedAnswer,
    rawModelAnswer: input.completionGuard?.rawModelAnswer,
    partialSummary: input.partialSummary,
    toolLedger: toolLedgerToSummary(ledger),
    toolLedgerSummary: toolLedgerToSummary(ledger),
    suggestedBudget:
      needsMoreBudget && input.budgetExhausted
        ? input.budgetManager.buildSuggestedBudget(input.budgetExhausted)
        : undefined,
  };
  const presentation = presentExecutionState(base);
  base.userFacingState = presentation.userFacingState;
  base.userFacingLabel = presentation.userFacingLabel;
  if (!needsMoreBudget || !input.budgetExhausted) return base;
  return input.finalizer.enrichExecutionMeta(base, {
    steps: input.steps,
    budgetExhausted: input.budgetExhausted,
    budgetManager: input.budgetManager,
    mode: input.policy.mode,
    goal: input.goal,
    location,
  });
}

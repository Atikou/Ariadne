import type { BudgetManager } from "./BudgetManager.js";
import type { CapabilityEscalationRecord } from "./CapabilityEscalation.js";
import {
  buildEffectiveWorkflowContext,
  type EffectiveWorkflowContext,
} from "./EffectiveWorkflowContext.js";
import type { AgentIntentType, AgentWorkflowType } from "./IntentTypes.js";
import {
  buildPausedRunRuntimeState,
  restorePausedRunRuntimeState,
} from "./AgentPausedRunSnapshot.js";
import type { PausedRunRuntimeState } from "./PausedRunStore.js";
import type { AgentModelTurnMetric } from "./AgentRunUsageSummary.js";
import type {
  AgentWorkflowDebugAnalysis,
  AgentWorkflowDebugFix,
  AgentWorkflowProposal,
  AgentWorkflowRefactorPlan,
  AgentWorkflowWritePhase,
  RunPolicy,
} from "./RunPolicyTypes.js";
import {
  normalizeCompletionCriteria,
  type CompletionCriterionInput,
} from "./completion/TaskCompletionContract.js";
import { resolveEffectiveIntent } from "./capabilityEscalationRuntime.js";
import { FailedActionMemory } from "./recovery/FailedActionMemory.js";
import { RunToolResultCache } from "./recovery/RunToolResultCache.js";
import type { WorkflowWriteOrchestratorResult } from "./workflowWriteOrchestrator.js";

/** Mutable data center shared by the loop and the one-way tool execution workflow. */
export class AgentToolRuntimeState {
  modelTurnMetrics: AgentModelTurnMetric[] = [];
  workflowProposals: AgentWorkflowProposal[] = [];
  workflowDebugAnalyses: AgentWorkflowDebugAnalysis[] = [];
  workflowRefactorPlans: AgentWorkflowRefactorPlan[] = [];
  workflowWritePhases: AgentWorkflowWritePhase[] = [];
  workflowDebugFixes: AgentWorkflowDebugFix[] = [];
  capabilityEscalations: CapabilityEscalationRecord[] = [];
  reconciledWorkflowType?: AgentWorkflowType;
  reconciledIntent?: AgentIntentType;
  entryIntent?: AgentIntentType;
  entryWorkflowType?: AgentWorkflowType;
  pendingWritePhaseContext?: string;
  completionCriteria!: CompletionCriterionInput[];
  readonly toolResultCache = new RunToolResultCache();
  failedActionMemory!: FailedActionMemory;

  constructor(policy: RunPolicy, criteria?: readonly CompletionCriterionInput[]) {
    this.reset(policy, criteria);
  }

  reset(policy: RunPolicy, criteria?: readonly CompletionCriterionInput[]): void {
    this.modelTurnMetrics = [];
    this.workflowProposals = [];
    this.workflowDebugAnalyses = [];
    this.workflowRefactorPlans = [];
    this.workflowWritePhases = [];
    this.workflowDebugFixes = [];
    this.capabilityEscalations = [];
    this.reconciledWorkflowType = undefined;
    this.reconciledIntent = undefined;
    this.entryIntent = policy.intent;
    this.entryWorkflowType = policy.workflowType;
    this.pendingWritePhaseContext = undefined;
    this.completionCriteria = normalizeCompletionCriteria(criteria);
    this.toolResultCache.invalidateAll();
    this.failedActionMemory = new FailedActionMemory(policy.budget.maxRepeatedToolFailures);
  }

  getEffectiveIntent(policy: RunPolicy): AgentIntentType {
    return resolveEffectiveIntent(policy.intent, this.reconciledIntent);
  }

  getEffectiveWorkflowContext(policy: RunPolicy): EffectiveWorkflowContext {
    return buildEffectiveWorkflowContext({
      entryIntent: this.entryIntent ?? policy.intent,
      entryWorkflowType: this.entryWorkflowType ?? policy.workflowType,
      reconciledIntent: this.reconciledIntent,
      reconciledWorkflowType: this.reconciledWorkflowType,
      capabilityEscalations: this.capabilityEscalations,
    });
  }

  applyCapabilityReconciliation(input: {
    reconciledIntent?: AgentIntentType;
    reconciledWorkflowType?: AgentWorkflowType;
  }): void {
    if (input.reconciledIntent) this.reconciledIntent = input.reconciledIntent;
    if (input.reconciledWorkflowType) this.reconciledWorkflowType = input.reconciledWorkflowType;
  }

  applyWorkflowWrite(result?: WorkflowWriteOrchestratorResult): void {
    if (!result || result.writePhaseBlocked) return;
    if (result.writePhaseRecord) this.workflowWritePhases.push(result.writePhaseRecord);
    if (result.debugFixRecord) this.workflowDebugFixes.push(result.debugFixRecord);
    if (result.pendingWritePhaseContext) {
      this.pendingWritePhaseContext = result.pendingWritePhaseContext;
    }
  }

  buildPausedRuntimeState(policy: RunPolicy, budgetManager: BudgetManager): PausedRunRuntimeState {
    return buildPausedRunRuntimeState({
      entryIntent: this.entryIntent ?? policy.intent,
      entryWorkflowType: this.entryWorkflowType ?? policy.workflowType,
      reconciledIntent: this.reconciledIntent,
      reconciledWorkflowType: this.reconciledWorkflowType,
      capabilityEscalations: this.capabilityEscalations,
      budgetManager,
      failedActionMemory: this.failedActionMemory,
      toolResultCache: this.toolResultCache,
    });
  }

  restorePausedRuntimeState(state: PausedRunRuntimeState, budgetManager: BudgetManager): void {
    if (state.entryIntent) this.entryIntent = state.entryIntent;
    if (state.entryWorkflowType) this.entryWorkflowType = state.entryWorkflowType;
    this.reconciledIntent = state.reconciledIntent;
    this.reconciledWorkflowType = state.reconciledWorkflowType;
    restorePausedRunRuntimeState(
      {
        capabilityEscalations: this.capabilityEscalations,
        failedActionMemory: this.failedActionMemory,
        toolResultCache: this.toolResultCache,
        budgetManager,
      },
      state,
    );
  }
}

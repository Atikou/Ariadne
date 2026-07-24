import type { ChatMessage } from "../model/types.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PlanHandoffStore } from "../policy/PlanHandoffStore.js";
import type { PermissionRequestStore } from "../policy/PermissionRequestStore.js";
import type { PermissionRequestPayload } from "../policy/permissionRequestTypes.js";
import type { PlanHandoffPayload } from "../policy/planHandoffTypes.js";
import type { ToolAction } from "./AgentActionParser.js";
import {
  buildPausedRunSnapshot,
  createJitPermissionRequestFromStep,
} from "./AgentPausedRunSnapshot.js";
import type {
  AgentHandoffAuthorizationContext,
  PausedRunRuntimeState,
  PausedRunStore,
} from "./PausedRunStore.js";
import type { ToolPermission } from "../core/permissions.js";
import { planHandoffMessageForVariant } from "./planHandoffMessages.js";
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
import type { AgentIntentType } from "./IntentTypes.js";
import type { AgentToolStep } from "./toolStep.js";
import type { CompletionCriterionInput } from "./completion/TaskCompletionContract.js";

export interface AgentPauseCoordinatorDeps {
  permissionRequestStore: PermissionRequestStore;
  planHandoffStore: PlanHandoffStore;
  pausedRunStore: PausedRunStore;
  runId?: string;
  sessionId?: string;
  projectId?: string;
  mode: AgentRunMode;
  permissionPolicy: UserPermissionPolicy;
  intent: AgentIntentType;
  executionStage: AgentExecutionStage;
  planVariant?: PlanExecutionVariant;
  skipPlanHandoff?: boolean;
  permissionCeiling?: ToolPermission[];
  runGrantedPermissions?: ToolPermission[];
  handoffAuthorization?: AgentHandoffAuthorizationContext;
}

export interface AgentPauseRuntimeSnapshot {
  runtimeState: PausedRunRuntimeState;
  workflowProposals: AgentWorkflowProposal[];
  workflowDebugAnalyses: AgentWorkflowDebugAnalysis[];
  workflowRefactorPlans: AgentWorkflowRefactorPlan[];
  workflowInternalPlans: AgentWorkflowInternalPlan[];
  completionCriteria: CompletionCriterionInput[];
}

export interface AgentPauseConversationSnapshot {
  sessionId?: string;
  goal: string;
  system?: string;
  messages: ChatMessage[];
  steps: AgentToolStep[];
  modelTurns: number;
}

export interface ToolPermissionPauseInput extends AgentPauseConversationSnapshot {
  step: AgentToolStep;
  action: ToolAction;
  intent: AgentIntentType;
  runtime: AgentPauseRuntimeSnapshot;
}

export interface PlanHandoffPauseInput extends AgentPauseConversationSnapshot {
  planMarkdown: string;
  runtime: AgentPauseRuntimeSnapshot;
}

/** Owns permission/plan pause records and their matching resumable snapshot. */
export class AgentPauseCoordinator {
  private readonly resolvedRunId: string;

  constructor(private readonly deps: AgentPauseCoordinatorDeps) {
    this.resolvedRunId = deps.runId?.trim() || `ephemeral:${randomUUID()}`;
  }

  createToolPermissionPause(input: ToolPermissionPauseInput): PermissionRequestPayload {
    const runId = this.runId();
    const snapshot = this.buildSnapshot(input, input.runtime, {
      pendingAction: { tool: input.action.tool, input: input.action.input },
      steps: input.steps.slice(0, -1),
    });
    return this.persistSnapshotThenCreate(snapshot, () => {
      const request = createJitPermissionRequestFromStep({
        permissionRequestStore: this.deps.permissionRequestStore,
        step: input.step,
        runId,
        sessionId: input.sessionId ?? this.deps.sessionId,
        projectId: this.deps.projectId,
        intent: input.intent,
        executionStage: this.deps.executionStage,
        planVariant: this.deps.planVariant,
      });
      if (
        request.runId !== runId
        || request.blockedTool?.name !== input.action.tool
        || !isDeepStrictEqual(request.blockedTool.input, input.action.input)
      ) {
        throw new Error("当前 Run 已有不匹配的待批准工具申请");
      }
      return request;
    });
  }

  createPlanHandoff(input: PlanHandoffPauseInput): PlanHandoffPayload | null {
    if (this.deps.skipPlanHandoff) return null;
    if (this.deps.mode !== "plan" || this.deps.intent !== "plan") return null;

    const runId = this.runId();
    const planVariant = this.deps.planVariant ?? "plan_only";
    const snapshot = this.buildSnapshot(input, input.runtime, { resumeMode: "implement" });
    return this.persistSnapshotThenCreate(snapshot, () => {
      const handoff = this.deps.planHandoffStore.create({
        runId,
        sessionId: input.sessionId ?? this.deps.sessionId,
        planMarkdown: input.planMarkdown,
        planVariant,
        message: planHandoffMessageForVariant(planVariant),
      });
      if (
        handoff.runId !== runId
        || handoff.planMarkdown !== input.planMarkdown
        || handoff.planVariant !== planVariant
      ) {
        throw new Error("当前 Run 已有不匹配的待批准计划交接");
      }
      return handoff;
    });
  }

  private buildSnapshot(
    input: AgentPauseConversationSnapshot,
    runtime: AgentPauseRuntimeSnapshot,
    overrides: {
      steps?: AgentToolStep[];
      pendingAction?: { tool: string; input?: Record<string, unknown> };
      resumeMode?: AgentRunMode;
    },
  ) {
    return buildPausedRunSnapshot({
      runId: this.runId(),
      sessionId: input.sessionId ?? this.deps.sessionId,
      goal: input.goal,
      system: input.system,
      messages: input.messages,
      steps: overrides.steps ?? input.steps,
      modelTurns: input.modelTurns,
      pendingAction: overrides.pendingAction,
      mode: this.deps.mode,
      permissionPolicy: this.deps.permissionPolicy,
      permissionCeiling: this.deps.permissionCeiling,
      runGrantedPermissions: this.deps.runGrantedPermissions,
      handoffAuthorization: this.deps.handoffAuthorization,
      resumeMode: overrides.resumeMode,
      runtimeState: runtime.runtimeState,
      workflowProposals: runtime.workflowProposals,
      workflowDebugAnalyses: runtime.workflowDebugAnalyses,
      workflowRefactorPlans: runtime.workflowRefactorPlans,
      workflowInternalPlans: runtime.workflowInternalPlans,
      completionCriteria: runtime.completionCriteria,
    });
  }

  private persistSnapshotThenCreate<T>(snapshot: ReturnType<typeof buildPausedRunSnapshot>, create: () => T): T {
    const previous = this.deps.pausedRunStore.get(snapshot.runId);
    this.deps.pausedRunStore.save(snapshot);
    try {
      return create();
    } catch (error) {
      try {
        if (previous) this.deps.pausedRunStore.save(previous);
        else this.deps.pausedRunStore.delete(snapshot.runId);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "暂停记录创建失败，且快照回滚失败");
      }
      throw error;
    }
  }

  private runId(): string {
    return this.resolvedRunId;
  }
}

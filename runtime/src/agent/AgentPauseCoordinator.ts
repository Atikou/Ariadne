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
  PendingToolAction,
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
import {
  defaultAgentPlanStore,
  type AgentPlanStore,
} from "../plan/AgentPlanStore.js";
import type {
  AgentPlanContract,
  AgentPlanModelDraft,
} from "../plan/AgentPlanContract.js";
import type { CompletionCriterionInput } from "./completion/TaskCompletionContract.js";
import type { RunAggregateRepository } from "../run/RunAggregateRepository.js";

export interface AgentPauseCoordinatorDeps {
  permissionRequestStore: PermissionRequestStore;
  planHandoffStore: PlanHandoffStore;
  agentPlanStore?: AgentPlanStore;
  pausedRunStore: PausedRunStore;
  runRepository?: RunAggregateRepository;
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
  planDraft: AgentPlanModelDraft;
  runtime: AgentPauseRuntimeSnapshot;
}

export type AgentPlanFinalization =
  | { kind: "clarification"; plan: AgentPlanContract }
  | { kind: "handoff"; plan: AgentPlanContract; handoff: PlanHandoffPayload };

/** Owns permission/plan pause records and their matching resumable snapshot. */
export class AgentPauseCoordinator {
  private readonly resolvedRunId: string;

  constructor(private readonly deps: AgentPauseCoordinatorDeps) {
    this.resolvedRunId = deps.runId?.trim() || `ephemeral:${randomUUID()}`;
  }

  createToolPermissionPause(input: ToolPermissionPauseInput): PermissionRequestPayload {
    const runId = this.runId();
    const snapshot = this.buildSnapshot(input, input.runtime, {
      pendingAction: {
        toolCallId: input.step.toolCallId ?? input.action.id,
        tool: input.action.tool,
        input: input.action.input,
      },
      steps: input.steps.slice(0, -1),
    });
    return this.persistPause(snapshot, "permission", () => {
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

  createPlanFinalization(input: PlanHandoffPauseInput): AgentPlanFinalization | null {
    if (this.deps.skipPlanHandoff) return null;
    if (this.deps.mode !== "plan" || this.deps.intent !== "plan") return null;

    const runId = this.runId();
    const planStore = this.deps.agentPlanStore ?? defaultAgentPlanStore;
    return planStore.transactionalCreateFromModel({
      draft: input.planDraft,
      runId,
      sessionId: input.sessionId ?? this.deps.sessionId,
    }, (plan) => {
      if (plan.planState === "needs_clarification") {
        return { kind: "clarification", plan };
      }
      const planVariant = this.deps.planVariant ?? "plan_only";
      const snapshot = this.buildSnapshot(input, input.runtime, {
        resumeMode: "implement",
        approvedPlan: plan,
      });
      const handoff = this.persistPause(snapshot, "plan", () => {
        const created = this.deps.planHandoffStore.create({
          runId,
          sessionId: input.sessionId ?? this.deps.sessionId,
          plan,
          planVariant,
          message: planHandoffMessageForVariant(planVariant),
        });
        if (
          created.runId !== runId
          || created.planId !== plan.planId
          || created.planVersion !== plan.version
          || created.planVariant !== planVariant
        ) {
          throw new Error("当前 Run 已有不匹配的待批准计划交接");
        }
        return created;
      });
      return { kind: "handoff", plan, handoff };
    });
  }

  private buildSnapshot(
    input: AgentPauseConversationSnapshot,
    runtime: AgentPauseRuntimeSnapshot,
    overrides: {
      steps?: AgentToolStep[];
      pendingAction?: PendingToolAction;
      resumeMode?: AgentRunMode;
      approvedPlan?: AgentPlanContract;
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
      approvedPlan: overrides.approvedPlan,
      runtimeState: runtime.runtimeState,
      workflowProposals: runtime.workflowProposals,
      workflowDebugAnalyses: runtime.workflowDebugAnalyses,
      workflowRefactorPlans: runtime.workflowRefactorPlans,
      workflowInternalPlans: runtime.workflowInternalPlans,
      completionCriteria: runtime.completionCriteria,
    });
  }

  private persistPause<T>(
    snapshot: ReturnType<typeof buildPausedRunSnapshot>,
    decision: "permission" | "plan",
    create: () => T,
  ): T {
    return this.deps.pausedRunStore.transactionalSave(snapshot, () => {
      const result = create();
      const run = this.deps.runRepository?.get(snapshot.runId);
      if (run) {
        this.deps.runRepository!.execute(decision === "permission"
          ? {
              type: "run.request_confirmation",
              runId: run.id,
              expectedAggregateVersion: run.aggregateVersion,
              reason: {
                code: "permission_required",
                message: "The run is waiting for an explicit permission decision.",
              },
            }
          : {
              type: "run.request_plan_handoff",
              runId: run.id,
              expectedAggregateVersion: run.aggregateVersion,
              reason: {
                code: "plan_handoff_required",
                message: "The run is waiting for an explicit plan handoff decision.",
              },
            });
      }
      return result;
    });
  }

  private runId(): string {
    return this.resolvedRunId;
  }
}

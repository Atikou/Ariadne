import type { ChatMessage } from "../model/types.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolAction } from "./AgentActionParser.js";
import {
  reconcileCapabilityBeforeTool as applyCapabilityEscalationBeforeTool,
  type CapabilityEscalationTimelineSink,
  type ReconcileCapabilityBeforeToolResult,
} from "./AgentCapabilityEscalationOrchestrator.js";
import type { CapabilityEscalationRecord } from "./CapabilityEscalation.js";
import type { BudgetManager } from "./BudgetManager.js";
import { effectiveWorkflowRoute, type EffectiveWorkflowContext } from "./EffectiveWorkflowContext.js";
import type { RunBudgetKey, UserPermissionPolicy } from "./RunPolicyTypes.js";
import type { AgentToolStep } from "./toolStep.js";
import type { WorkflowRouteResult } from "./WorkflowRouter.js";

export type AgentToolStepPipelineResult =
  | { kind: "step"; step: AgentToolStep }
  | { kind: "pause"; step: AgentToolStep; pauseSteps: AgentToolStep[] }
  | { kind: "budget"; step: AgentToolStep; budgetExhausted: RunBudgetKey };

export interface AgentToolStepPipelineContext {
  registry: ToolRegistry;
  permissionPolicy: UserPermissionPolicy;
  getWorkflowContext: () => EffectiveWorkflowContext;
  capabilityEscalations: CapabilityEscalationRecord[];
  budgetManager: BudgetManager;
  timeline?: CapabilityEscalationTimelineSink;
  runId?: string;
  pauseOnPermissionRequest: boolean;
  runToolAction: (
    action: ToolAction,
    iteration: number,
    toolCallId: string,
    ctx: {
      steps: AgentToolStep[];
      goal: string;
      workflowRoute: Pick<
        WorkflowRouteResult,
        "workflowKind" | "readonlyOnly" | "enforceReadOnlyTools" | "sideEffectKind"
      >;
      userConfirmed: boolean;
      activityBatchId?: string;
      activityLaneId?: string;
      activityParentId?: string;
      activityDependsOnToolCallIds?: string[];
      verifiesToolCallId?: string;
    },
  ) => Promise<AgentToolStep>;
  onCapabilityReconciled?: (result: ReconcileCapabilityBeforeToolResult) => void;
}

export interface ExecuteAgentToolStepInput {
  action: ToolAction;
  iteration: number;
  toolCallId: string;
  steps: AgentToolStep[];
  goal: string;
  messages: ChatMessage[];
  skipJitPause?: boolean;
  activityBatchId?: string;
  activityLaneId?: string;
  activityParentId?: string;
  activityDependsOnToolCallIds?: string[];
  verifiesToolCallId?: string;
}

/**
 * 主循环只负责编排 capability escalation 和暂停/收尾；
 * workflow、路径、权限、预算由 Runner 通过同一个 ToolExecutionGateway 决策对象完成。
 */
export async function executeAgentToolStepPipeline(
  ctx: AgentToolStepPipelineContext,
  input: ExecuteAgentToolStepInput,
): Promise<AgentToolStepPipelineResult> {
  const tool = ctx.registry.get(input.action.tool);
  const entryWorkflowRoute = effectiveWorkflowRoute(ctx.getWorkflowContext());
  const escalationResult = applyCapabilityEscalationBeforeTool({
    action: input.action,
    toolPermission: tool?.permissions[0],
    workflowRoute: entryWorkflowRoute,
    iteration: input.iteration,
    messages: input.messages,
    capabilityEscalations: ctx.capabilityEscalations,
    budgetManager: ctx.budgetManager,
    permissionPolicy: ctx.permissionPolicy,
    timeline: ctx.timeline,
    runId: ctx.runId,
  });
  ctx.onCapabilityReconciled?.(escalationResult);

  const reconciledWorkflowRoute = effectiveWorkflowRoute(ctx.getWorkflowContext());
  const step = await ctx.runToolAction(input.action, input.iteration, input.toolCallId, {
    steps: input.steps,
    goal: input.goal,
    workflowRoute: reconciledWorkflowRoute,
    userConfirmed: input.skipJitPause === true,
    activityBatchId: input.activityBatchId,
    activityLaneId: input.activityLaneId,
    activityParentId: input.activityParentId,
    activityDependsOnToolCallIds: input.activityDependsOnToolCallIds,
    verifiesToolCallId: input.verifiesToolCallId,
  });

  if (step.blockedReasonKind === "budget" && step.budgetExhausted) {
    return {
      kind: "budget",
      step,
      budgetExhausted: step.budgetExhausted,
    };
  }

  if (
    !input.skipJitPause &&
    ctx.pauseOnPermissionRequest &&
    step.blocked &&
    step.confirmationRequest?.status === "waiting_confirmation"
  ) {
    return { kind: "pause", step, pauseSteps: [...input.steps, step] };
  }

  return { kind: "step", step };
}

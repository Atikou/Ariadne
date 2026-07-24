import type { ToolPermission } from "../core/permissions.js";
import type { ChatMessage } from "../model/types.js";
import type { ToolAction } from "./AgentActionParser.js";
import type { BudgetManager } from "./BudgetManager.js";
import {
  evaluateCapabilityEscalation,
  renderCapabilityEscalationContext,
  type CapabilityEscalation,
  type CapabilityEscalationRecord,
} from "./CapabilityEscalation.js";
import type { AgentIntentType, AgentWorkflowType } from "./IntentTypes.js";
import type { UserPermissionPolicy } from "./RunPolicyTypes.js";
import type { WorkflowRouteResult } from "./WorkflowRouter.js";
import {
  applyEscalationBudget,
  formatCapabilityEscalationTimelineContent,
} from "./capabilityEscalationRuntime.js";

export interface CapabilityEscalationTimelineSink {
  recordCapabilityEscalation(input: {
    runId: string;
    title: string;
    content: string;
    metadata?: { toolName?: string; filePath?: string };
  }): void;
}

export interface ReconcileCapabilityBeforeToolInput {
  action: ToolAction;
  toolPermission?: ToolPermission;
  workflowRoute: WorkflowRouteResult;
  iteration: number;
  messages?: ChatMessage[];
  capabilityEscalations: CapabilityEscalationRecord[];
  budgetManager: BudgetManager;
  permissionPolicy: UserPermissionPolicy;
  timeline?: CapabilityEscalationTimelineSink;
  runId?: string;
}

export interface ReconcileCapabilityBeforeToolResult {
  reconciledIntent?: AgentIntentType;
  reconciledWorkflowType?: AgentWorkflowType;
}

/** soft workflow 工具超出预期时升级 reconciled workflow，并注入系统上下文 / Timeline。 */
export function reconcileCapabilityBeforeTool(
  input: ReconcileCapabilityBeforeToolInput,
): ReconcileCapabilityBeforeToolResult {
  const escalation = evaluateCapabilityEscalation({
    workflowRoute: input.workflowRoute,
    toolName: input.action.tool,
    toolPermission: input.toolPermission,
  });
  if (!escalation?.canEscalate) return {};

  const alreadyRecorded = input.capabilityEscalations.some(
    (e) =>
      e.requestedTool === escalation.requestedTool &&
      e.requestedPermission === escalation.requestedPermission &&
      e.fromWorkflow === escalation.fromWorkflow,
  );
  if (alreadyRecorded) return {};

  const record: CapabilityEscalationRecord = {
    ...escalation,
    iteration: input.iteration,
    applied: true,
  };
  input.capabilityEscalations.push(record);
  applyEscalationBudget(input.budgetManager, escalation.targetSideEffects);
  recordCapabilityEscalationTimeline({
    escalation,
    action: input.action,
    permissionPolicy: input.permissionPolicy,
    timeline: input.timeline,
    runId: input.runId,
  });

  if (input.messages) {
    input.messages.push({
      role: "system",
      content: renderCapabilityEscalationContext(escalation),
    });
  }

  return {
    reconciledWorkflowType: escalation.toWorkflow,
    reconciledIntent: escalation.toIntent,
  };
}

function recordCapabilityEscalationTimeline(input: {
  escalation: CapabilityEscalation;
  action: ToolAction;
  permissionPolicy: UserPermissionPolicy;
  timeline?: CapabilityEscalationTimelineSink;
  runId?: string;
}): void {
  const tl = input.timeline;
  const runId = input.runId;
  if (!tl || !runId) return;
  const targetPath = (input.action.input as { path?: string } | undefined)?.path;
  tl.recordCapabilityEscalation({
    runId,
    title: `能力升级：${input.escalation.fromWorkflow} → ${input.escalation.toWorkflow}`,
    content: formatCapabilityEscalationTimelineContent({
      escalation: { ...input.escalation, iteration: 0, applied: true },
      permissionPolicy: input.permissionPolicy,
      targetPath,
    }),
    metadata: {
      toolName: input.escalation.requestedTool,
      filePath: targetPath,
    },
  });
}

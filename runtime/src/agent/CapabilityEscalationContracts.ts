import type { ToolPermission } from "../core/permissions.js";
import type { AgentIntentType, AgentWorkflowType } from "./IntentTypes.js";

export interface CapabilityEscalation {
  fromWorkflow: AgentWorkflowType;
  fromIntent: AgentIntentType;
  toWorkflow: AgentWorkflowType;
  toIntent: AgentIntentType;
  requestedTool: string;
  requestedPermission: ToolPermission;
  currentExpectedSideEffects: ToolPermission[];
  targetSideEffects: ToolPermission[];
  canEscalate: boolean;
  reason: string;
}

export interface CapabilityEscalationRecord extends CapabilityEscalation {
  iteration: number;
  applied: boolean;
}

export type AgentCapabilityEscalation = CapabilityEscalationRecord;

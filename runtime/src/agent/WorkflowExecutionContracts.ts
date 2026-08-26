import type { ToolPermission } from "../core/permissions.js";
import type { AgentIntentType, AgentWorkflowType } from "./IntentTypes.js";
import type { UserPermissionPolicy } from "./RunPolicyPrimitives.js";

export interface AgentWorkflowProposal {
  workflowType: Extract<AgentWorkflowType, "editWorkflow" | "generateFileWorkflow">;
  phase: "proposal";
  goal: string;
  intent: Extract<AgentIntentType, "edit" | "generate_file">;
  permissionPolicy: UserPermissionPolicy;
  requiredFields: string[];
  writeAllowedByPolicy: boolean;
  requiresConfirmationBeforeWrite: boolean;
  permissionChecks: AgentWorkflowPermissionCheck[];
  permissionSummary: "write_allowed" | "confirmation_required" | "denied";
}

export interface AgentWorkflowPermissionCheck {
  toolName: "apply_patch" | "write_file";
  permission: Extract<ToolPermission, "write">;
  decision: "allow" | "needsConfirmation" | "deny";
  reason?: string;
  risk: {
    tier: "low" | "medium" | "high" | "critical";
    category: string;
    requiresConfirmation: boolean;
    policyBlocked: boolean;
  };
}

export interface AgentWorkflowDiffRecord {
  toolCallId?: string;
  tool: "write_file" | "apply_patch";
  path?: string;
  changeId?: string;
  beforeHash?: string;
  afterHash?: string;
  diff?: string;
  diffTruncated: boolean;
}

export interface AgentWorkflowVerificationRecord {
  workflowType: Extract<
    AgentWorkflowType,
    "editWorkflow" | "generateFileWorkflow" | "debugWorkflow" | "refactorWorkflow"
  >;
  writeToolCallId?: string;
  writeTool: "write_file" | "apply_patch";
  path?: string;
  changeId?: string;
  verificationToolCallId?: string;
  verificationTool: string;
  ok: boolean;
  blocked?: boolean;
  error?: string;
  outputPreview?: string;
}

export interface AgentWorkflowCorrectionRecord {
  workflowType: Extract<
    AgentWorkflowType,
    "editWorkflow" | "generateFileWorkflow" | "debugWorkflow" | "refactorWorkflow"
  >;
  phase: "correction" | "termination";
  path?: string;
  changeId?: string;
  writeToolCallId?: string;
  verificationToolCallId?: string;
  verificationTool: string;
  attempt: number;
  maxAttempts: number;
  limitReached: boolean;
  verificationError?: string;
}

export interface AgentWorkflowDebugAnalysis {
  workflowType: Extract<AgentWorkflowType, "debugWorkflow">;
  phase: "analysis";
  goal: string;
  intent: Extract<AgentIntentType, "debug">;
  permissionPolicy: UserPermissionPolicy;
  requiredFields: string[];
  suggestedTools: string[];
  writeAllowedByPolicy: boolean;
  requiresConfirmationBeforeWrite: boolean;
}

export interface AgentWorkflowWritePhase {
  workflowType: Extract<
    AgentWorkflowType,
    "editWorkflow" | "generateFileWorkflow" | "refactorWorkflow"
  >;
  phase: "write";
  goal: string;
  intent: Extract<AgentIntentType, "edit" | "generate_file" | "refactor">;
  permissionPolicy: UserPermissionPolicy;
  writeTool: "write_file" | "apply_patch";
  proposalReady: boolean;
  readToolsBeforeWrite: number;
  gated: true;
}

export interface AgentWorkflowDebugFix {
  workflowType: Extract<AgentWorkflowType, "debugWorkflow">;
  phase: "fix";
  goal: string;
  permissionPolicy: UserPermissionPolicy;
  writeTool: "write_file" | "apply_patch";
  analysisReady: boolean;
  readToolsBeforeWrite: number;
  gated: true;
}

export interface AgentWorkflowRefactorPlan {
  workflowType: Extract<AgentWorkflowType, "refactorWorkflow">;
  phase: "plan";
  goal: string;
  intent: Extract<AgentIntentType, "refactor">;
  permissionPolicy: UserPermissionPolicy;
  requiredFields: string[];
  maxStages: number;
  suggestedTools: string[];
  writeAllowedByPolicy: boolean;
  requiresConfirmationBeforeWrite: boolean;
}

export interface AgentWorkflowInternalPlan {
  workflowType: AgentWorkflowType;
  phase: "implicit";
  goal: string;
  intent: AgentIntentType;
  permissionPolicy: UserPermissionPolicy;
  requiredFields: string[];
  complexitySignals: string[];
  userVisiblePlanMode: false;
  maxSteps: number;
}

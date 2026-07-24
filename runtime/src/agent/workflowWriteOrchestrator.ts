import { DebugFixWorkflow } from "./DebugFixWorkflow.js";
import { EditWriteWorkflow } from "./EditWriteWorkflow.js";
import type { AgentIntentType } from "./IntentTypes.js";
import type {
  AgentWorkflowDebugAnalysis,
  AgentWorkflowDebugFix,
  AgentWorkflowProposal,
  AgentWorkflowRefactorPlan,
  AgentWorkflowWritePhase,
  UserPermissionPolicy,
} from "./RunPolicyTypes.js";
import { assessWorkflowWriteGate } from "./WorkflowWriteGate.js";
import type { AgentToolStep } from "./toolStep.js";

export interface WorkflowWriteOrchestratorInput {
  intent: AgentIntentType;
  goal: string;
  permissionPolicy: UserPermissionPolicy;
  tool: string;
  steps: AgentToolStep[];
  hasProposal: boolean;
  hasDebugAnalysis: boolean;
  hasRefactorPlan: boolean;
}

export interface WorkflowWriteOrchestratorResult {
  blockedReason?: string;
  writePhaseBlocked?: boolean;
  pendingWritePhaseContext?: string;
  writePhaseRecord?: AgentWorkflowWritePhase;
  debugFixRecord?: AgentWorkflowDebugFix;
}

export function orchestrateWorkflowWrite(input: WorkflowWriteOrchestratorInput): WorkflowWriteOrchestratorResult {
  const writeGate = assessWorkflowWriteGate({
    intent: input.intent,
    goal: input.goal,
    tool: input.tool,
    steps: input.steps,
    hasProposal: input.hasProposal,
    hasDebugAnalysis: input.hasDebugAnalysis,
    hasRefactorPlan: input.hasRefactorPlan,
  });
  if (writeGate.blocked) {
    return {
      blockedReason: writeGate.reason ?? "workflow write gate blocked",
      writePhaseBlocked: true,
    };
  }
  if (
    writeGate.priorWrites > 0 ||
    (input.tool !== "write_file" && input.tool !== "apply_patch")
  ) {
    return {};
  }
  const editWrite = new EditWriteWorkflow().run({
    goal: input.goal,
    intent: input.intent,
    permissionPolicy: input.permissionPolicy,
    gate: writeGate,
    tool: input.tool,
  });
  const debugFix = new DebugFixWorkflow().run({
    goal: input.goal,
    intent: input.intent,
    permissionPolicy: input.permissionPolicy,
    gate: writeGate,
    tool: input.tool,
  });
  return {
    writePhaseRecord: editWrite?.record,
    debugFixRecord: debugFix?.record,
    pendingWritePhaseContext: debugFix?.modelContext ?? editWrite?.modelContext,
  };
}

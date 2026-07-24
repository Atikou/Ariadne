import type { AgentIntentType } from "./IntentTypes.js";
import type { AgentWorkflowWritePhase, UserPermissionPolicy } from "./RunPolicyTypes.js";
import type { WorkflowWriteGateResult } from "./WorkflowWriteGate.js";

export interface EditWriteWorkflowInput {
  goal: string;
  intent: AgentIntentType;
  permissionPolicy: UserPermissionPolicy;
  gate: WorkflowWriteGateResult;
  tool: "write_file" | "apply_patch";
}

export interface EditWriteWorkflowResult {
  modelContext: string;
  record: AgentWorkflowWritePhase;
}

/**
 * Write phase for edit/generate-file/refactor workflows.
 *
 * The workflow does not execute writes. It records the first gated write attempt and
 * injects execution guidance that ties the mutation back to the proposal phase.
 */
export class EditWriteWorkflow {
  run(input: EditWriteWorkflowInput): EditWriteWorkflowResult | undefined {
    if (input.intent !== "edit" && input.intent !== "generate_file" && input.intent !== "refactor") {
      return undefined;
    }
    if (input.gate.blocked || input.gate.priorWrites > 0) return undefined;

    const intent = input.intent === "generate_file"
      ? "generate_file"
      : input.intent === "refactor"
        ? "refactor"
        : "edit";
    const workflowType = intent === "generate_file"
      ? "generateFileWorkflow"
      : intent === "refactor"
        ? "refactorWorkflow"
        : "editWorkflow";
    const record: AgentWorkflowWritePhase = {
      workflowType,
      phase: "write",
      goal: input.goal,
      intent,
      permissionPolicy: input.permissionPolicy,
      writeTool: input.tool,
      proposalReady: true,
      readToolsBeforeWrite: input.gate.readToolsBeforeWrite,
      gated: true,
    };
    return {
      record,
      modelContext: renderWritePhaseContext(input.goal, workflowType, record),
    };
  }

  renderBlockedContext(goal: string, intent: AgentIntentType, reason: string): string {
    const workflowType = intent === "generate_file"
      ? "generateFileWorkflow"
      : intent === "refactor"
        ? "refactorWorkflow"
        : "editWorkflow";
    return [
      `${workflowType} write gate blocked:`,
      `goal: ${goal}`,
      `reason: ${reason}`,
      "",
      intent === "refactor"
        ? "Stay in refactor plan phase: use read/locate tools and finalize stagedChanges, perStageVerification, and riskAndRollback."
        : "Stay in proposal phase: use read/locate tools and finalize targetFiles, changeSummary, diffPlan, and verificationPlan.",
      "Do not call write_file or apply_patch until the workflow gate allows the first write.",
    ].join("\n");
  }
}

function renderWritePhaseContext(
  goal: string,
  workflowType: "editWorkflow" | "generateFileWorkflow" | "refactorWorkflow",
  record: AgentWorkflowWritePhase,
): string {
  return [
    `${workflowType} write phase:`,
    `goal: ${goal}`,
    `writeTool: ${record.writeTool}`,
    `readToolsBeforeWrite: ${record.readToolsBeforeWrite}`,
    "",
    workflowType === "refactorWorkflow"
      ? "Execute exactly one isolated refactor stage from the staged plan."
      : "Execute only the minimal change described in the proposal phase.",
    "Prefer apply_patch for small edits and write_file for new files or full rewrites.",
    "After the write completes, follow execution/verification guidance instead of repeating the same mutation.",
  ].join("\n");
}

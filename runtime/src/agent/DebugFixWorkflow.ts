import type { AgentIntentType } from "./IntentTypes.js";
import type { AgentWorkflowDebugFix, UserPermissionPolicy } from "./RunPolicyTypes.js";
import type { WorkflowWriteGateResult } from "./WorkflowWriteGate.js";

export interface DebugFixWorkflowInput {
  goal: string;
  intent: AgentIntentType;
  permissionPolicy: UserPermissionPolicy;
  gate: WorkflowWriteGateResult;
  tool: "write_file" | "apply_patch";
}

export interface DebugFixWorkflowResult {
  modelContext: string;
  record: AgentWorkflowDebugFix;
}

/**
 * Minimal-fix phase for debugWorkflow.
 *
 * The workflow does not execute writes. It records the first gated fix attempt and
 * injects guidance that ties the mutation back to the analysis phase.
 */
export class DebugFixWorkflow {
  run(input: DebugFixWorkflowInput): DebugFixWorkflowResult | undefined {
    if (input.intent !== "debug") return undefined;
    if (input.gate.blocked || input.gate.priorWrites > 0) return undefined;

    const record: AgentWorkflowDebugFix = {
      workflowType: "debugWorkflow",
      phase: "fix",
      goal: input.goal,
      permissionPolicy: input.permissionPolicy,
      writeTool: input.tool,
      analysisReady: true,
      readToolsBeforeWrite: input.gate.readToolsBeforeWrite,
      gated: true,
    };
    return {
      record,
      modelContext: renderFixPhaseContext(input.goal, record),
    };
  }

  renderBlockedContext(goal: string, reason: string): string {
    return [
      "debugWorkflow fix gate blocked:",
      `goal: ${goal}`,
      `reason: ${reason}`,
      "",
      "Stay in analysis phase: confirm errorSummary, suspectedFiles, minimalFixPlan, and verificationPlan with read tools.",
      "Do not call write_file or apply_patch until the workflow gate allows the first minimal fix.",
    ].join("\n");
  }
}

function renderFixPhaseContext(goal: string, record: AgentWorkflowDebugFix): string {
  return [
    "debugWorkflow fix phase:",
    `goal: ${goal}`,
    `writeTool: ${record.writeTool}`,
    `readToolsBeforeWrite: ${record.readToolsBeforeWrite}`,
    "",
    "Apply only the smallest fix described in minimalFixPlan.",
    "After the write completes, run the planned verification before attempting broader changes.",
  ].join("\n");
}

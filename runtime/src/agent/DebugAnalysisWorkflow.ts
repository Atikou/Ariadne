import type { AgentIntentType } from "./IntentTypes.js";
import type { ToolPermission } from "../core/permissions.js";
import type { AgentWorkflowDebugAnalysis, UserPermissionPolicy } from "./RunPolicyTypes.js";

export interface DebugAnalysisWorkflowInput {
  goal: string;
  intent: AgentIntentType;
  permissionPolicy: UserPermissionPolicy;
  runGrantedPermissions?: readonly ToolPermission[];
}

export interface DebugAnalysisWorkflowResult {
  modelContext: string;
  analysis: AgentWorkflowDebugAnalysis;
}

const requiredDebugFields = [
  "errorSummary",
  "suspectedFiles",
  "rootCauseHypotheses",
  "minimalFixPlan",
  "verificationPlan",
  "riskAndRollback",
];

/**
 * Adds the analysis phase for debugWorkflow.
 *
 * This workflow is intentionally read-only. It turns the prelocated context into a
 * deterministic diagnosis contract before the model attempts a minimal fix.
 */
export class DebugAnalysisWorkflow {
  run(input: DebugAnalysisWorkflowInput): DebugAnalysisWorkflowResult | undefined {
    if (input.intent !== "debug") return undefined;
    return {
      modelContext: renderDebugAnalysisContext(input),
      analysis: buildDebugAnalysis(input),
    };
  }
}

function buildDebugAnalysis(input: DebugAnalysisWorkflowInput): AgentWorkflowDebugAnalysis {
  return {
    workflowType: "debugWorkflow",
    phase: "analysis",
    goal: input.goal,
    intent: "debug",
    permissionPolicy: input.permissionPolicy,
    requiredFields: requiredDebugFields,
    suggestedTools: ["locate_relevant_files", "context_pack", "read_file", "search_text"],
    writeAllowedByPolicy:
      input.permissionPolicy === "confirmBeforeEdit" ||
      input.permissionPolicy === "autoEdit" ||
      input.permissionPolicy === "confirmBeforeRun" ||
      input.permissionPolicy === "autoRun",
    requiresConfirmationBeforeWrite:
      !input.runGrantedPermissions?.includes("write"),
  };
}

function renderDebugAnalysisContext(input: DebugAnalysisWorkflowInput): string {
  return [
    "debugWorkflow analysis phase:",
    `goal: ${input.goal}`,
    `permissionPolicy: ${input.permissionPolicy}`,
    "",
    "Before any write-capable tool call, diagnose from the located context and produce a minimal repair plan.",
    "The analysis must cover:",
    "1. errorSummary: the observed error, failure signal, or broken behavior.",
    "2. suspectedFiles: exact files most likely involved, with a short reason.",
    "3. rootCauseHypotheses: one or more likely causes, ordered by confidence.",
    "4. minimalFixPlan: the smallest safe patch plan; keep reading if the target file or cause is unclear.",
    "5. verificationPlan: the smallest command, test, or read-back check that proves the fix.",
    "6. riskAndRollback: risk level and how to revert or stop if the hypothesis is wrong.",
    "",
    "Prefer read tools until the root cause and verification path are concrete. If no code change is needed, return final with the diagnosis.",
  ].join("\n");
}

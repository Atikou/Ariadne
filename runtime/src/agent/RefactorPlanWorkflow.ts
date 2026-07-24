import type { AgentIntentType } from "./IntentTypes.js";
import type { ToolPermission } from "../core/permissions.js";
import type { AgentWorkflowRefactorPlan, UserPermissionPolicy } from "./RunPolicyTypes.js";

export interface RefactorPlanWorkflowInput {
  goal: string;
  intent: AgentIntentType;
  permissionPolicy: UserPermissionPolicy;
  runGrantedPermissions?: readonly ToolPermission[];
}

export interface RefactorPlanWorkflowResult {
  modelContext: string;
  plan: AgentWorkflowRefactorPlan;
}

export const REFACTOR_PLAN_MAX_STAGES = 5;

const requiredRefactorFields = [
  "scopeSummary",
  "affectedModules",
  "stagedChanges",
  "perStageVerification",
  "riskAndRollback",
];

/**
 * Mandatory planning phase for refactorWorkflow.
 *
 * Refactor requests must produce a staged internal plan before any write-capable tool call.
 * This workflow is read-only and only injects the planning contract.
 */
export class RefactorPlanWorkflow {
  run(input: RefactorPlanWorkflowInput): RefactorPlanWorkflowResult | undefined {
    if (input.intent !== "refactor") return undefined;
    return {
      modelContext: renderRefactorPlanContext(input),
      plan: buildRefactorPlan(input),
    };
  }
}

function buildRefactorPlan(input: RefactorPlanWorkflowInput): AgentWorkflowRefactorPlan {
  return {
    workflowType: "refactorWorkflow",
    phase: "plan",
    goal: input.goal,
    intent: "refactor",
    permissionPolicy: input.permissionPolicy,
    requiredFields: requiredRefactorFields,
    maxStages: REFACTOR_PLAN_MAX_STAGES,
    suggestedTools: ["project_scan", "locate_relevant_files", "context_pack", "read_file", "search_text"],
    writeAllowedByPolicy:
      input.permissionPolicy === "confirmBeforeEdit" ||
      input.permissionPolicy === "autoEdit" ||
      input.permissionPolicy === "confirmBeforeRun" ||
      input.permissionPolicy === "autoRun",
    requiresConfirmationBeforeWrite:
      !input.runGrantedPermissions?.includes("write"),
  };
}

function renderRefactorPlanContext(input: RefactorPlanWorkflowInput): string {
  return [
    "refactorWorkflow plan phase:",
    `goal: ${input.goal}`,
    `permissionPolicy: ${input.permissionPolicy}`,
    `maxStages: ${REFACTOR_PLAN_MAX_STAGES}`,
    "",
    "Before any write-capable tool call, produce a staged refactor plan from the prescan context.",
    "The plan must cover:",
    "1. scopeSummary: what is being refactored and why.",
    "2. affectedModules: modules/files likely touched, ordered by dependency risk.",
    "3. stagedChanges: up to 5 ordered stages; each stage must list targetFiles, changeSummary, and why it is isolated.",
    "4. perStageVerification: the smallest read/test/check to run after each stage before moving on.",
    "5. riskAndRollback: rollback strategy and stop conditions if a stage fails verification.",
    "",
    "Execute only one stage at a time. Finish stage verification before starting the next stage.",
    "If the scope is unclear, keep reading until stagedChanges is concrete; do not jump directly to writes.",
  ].join("\n");
}

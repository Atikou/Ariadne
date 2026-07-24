import type { AgentIntentType } from "./IntentTypes.js";
import { evaluatePermissionGuard } from "../policy/PermissionGuard.js";
import type { ToolPermission } from "../core/permissions.js";
import type {
  AgentWorkflowPermissionCheck,
  AgentWorkflowProposal,
  UserPermissionPolicy,
} from "./RunPolicyTypes.js";

export interface EditProposalWorkflowInput {
  goal: string;
  intent: AgentIntentType;
  permissionPolicy: UserPermissionPolicy;
  allowedPermissions: ToolPermission[];
  runGrantedPermissions?: readonly ToolPermission[];
}

export interface EditProposalWorkflowResult {
  modelContext: string;
  proposal: AgentWorkflowProposal;
}

/**
 * Adds the proposal phase for write-oriented workflows.
 *
 * This workflow does not write files. It gives the model a deterministic contract for the
 * next phase so edit/generate-file requests do not jump from location directly to mutation.
 */
export class EditProposalWorkflow {
  run(input: EditProposalWorkflowInput): EditProposalWorkflowResult | undefined {
    if (input.intent !== "edit" && input.intent !== "generate_file") return undefined;
    return {
      modelContext: renderEditProposalContext(input),
      proposal: buildProposal(input),
    };
  }
}

const requiredProposalFields = [
  "targetFiles",
  "changeSummary",
  "permissionCheck",
  "diffPlan",
  "verificationPlan",
];

function buildProposal(input: EditProposalWorkflowInput): AgentWorkflowProposal {
  const intent = input.intent === "generate_file" ? "generate_file" : "edit";
  const workflowType = intent === "generate_file" ? "generateFileWorkflow" : "editWorkflow";
  const permissionChecks = buildPermissionChecks(input, intent);
  return {
    workflowType,
    phase: "proposal",
    goal: input.goal,
    intent,
    permissionPolicy: input.permissionPolicy,
    requiredFields: requiredProposalFields,
    writeAllowedByPolicy:
      input.permissionPolicy === "confirmBeforeEdit" ||
      input.permissionPolicy === "autoEdit" ||
      input.permissionPolicy === "confirmBeforeRun" ||
      input.permissionPolicy === "autoRun",
    requiresConfirmationBeforeWrite:
      !input.runGrantedPermissions?.includes("write"),
    permissionChecks,
    permissionSummary: summarizePermissionChecks(permissionChecks),
  };
}

function renderEditProposalContext(input: EditProposalWorkflowInput): string {
  const workflowName = input.intent === "generate_file" ? "generateFileWorkflow" : "editWorkflow";
  const actionName = input.intent === "generate_file" ? "create-file" : "edit";
  const permissionChecks = buildPermissionChecks(
    input,
    input.intent === "generate_file" ? "generate_file" : "edit",
  );
  return [
    `${workflowName} proposal phase:`,
    `goal: ${input.goal}`,
    `permissionPolicy: ${input.permissionPolicy}`,
    "preflightPermissionChecks:",
    ...permissionChecks.map((check) =>
      `- ${check.toolName}: ${check.decision}${check.reason ? ` (${check.reason})` : ""}; risk=${check.risk.tier}/${check.risk.category}`,
    ),
    "",
    "Before any write-capable tool call, form a concrete modification proposal from the located context.",
    "The proposal must cover:",
    "1. targetFiles: exact files or directories to create/update.",
    "2. changeSummary: the intended change in one or two sentences.",
    "3. permissionCheck: whether the current permission policy allows the next write-capable tool, and whether confirmation may be required.",
    "4. diffPlan: the expected patch shape or file creation plan before applying it.",
    "5. verificationPlan: the smallest useful check after the change.",
    "",
    `If the proposal is not concrete enough for ${actionName}, keep using read tools. If no write is needed, return final instead of calling write tools.`,
  ].join("\n");
}

function buildPermissionChecks(
  input: EditProposalWorkflowInput,
  intent: Extract<AgentIntentType, "edit" | "generate_file">,
): AgentWorkflowPermissionCheck[] {
  return (["apply_patch", "write_file"] as const).map((toolName) => {
    const decision = evaluatePermissionGuard({
      intent,
      permissionPolicy: input.permissionPolicy,
      toolName,
      permission: "write",
      input: {},
      allowedPermissions: input.allowedPermissions,
      runGrantedPermissions: input.runGrantedPermissions,
    });
    return {
      toolName,
      permission: "write",
      decision: decision.decision,
      reason: decision.reason,
      risk: {
        tier: decision.risk.tier,
        category: decision.risk.category,
        requiresConfirmation: decision.risk.requiresConfirmation,
        policyBlocked: decision.risk.policyBlocked,
      },
    };
  });
}

function summarizePermissionChecks(
  checks: AgentWorkflowPermissionCheck[],
): AgentWorkflowProposal["permissionSummary"] {
  if (checks.some((check) => check.decision === "allow")) return "write_allowed";
  if (checks.some((check) => check.decision === "needsConfirmation")) return "confirmation_required";
  return "denied";
}

export type ToolStepBlockedReasonKind = "workflow" | "permission" | "budget" | "policy";

export interface ToolVerificationBinding {
  kind: "write_readback" | "tool_success" | "artifact_check";
  systemAssigned: true;
  verifiesToolCallId?: string;
  criterionIds?: string[];
}

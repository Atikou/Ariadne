export const WORKFLOW_TOOL_NAMES = [
  "project_scan",
  "locate_relevant_files",
  "context_pack",
] as const;

export type WorkflowToolName = (typeof WORKFLOW_TOOL_NAMES)[number];

export type AgentWorkflowId =
  | "plan_prescan"
  | "implement_locate"
  | "edit_locate"
  | "debug_locate"
  | "generate_file_locate"
  | "refactor_locate";

export interface WorkflowPlan {
  id: AgentWorkflowId;
  reason: string;
  steps: readonly WorkflowToolName[];
  contextHeader: string;
  contextHint: string;
}

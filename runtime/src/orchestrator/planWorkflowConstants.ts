/** PlanWorkflow 固定三步；与 `PlanWorkflow` 执行顺序一致。 */
export const PLAN_WORKFLOW_STEP_IDS = [
  "project_scan",
  "locate_relevant_files",
  "context_pack",
] as const;

export type PlanWorkflowStepId = (typeof PLAN_WORKFLOW_STEP_IDS)[number];

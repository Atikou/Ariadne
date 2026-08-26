export type UserFacingExecutionState =
  | "answering"
  | "analyzing"
  | "planning"
  | "waiting_plan_approval"
  | "editing"
  | "debugging"
  | "waiting_tool_permission"
  | "verifying"
  | "write_gate_blocked"
  | "completed"
  | "completed_partial"
  | "failed"
  | "cancelled";

export interface ExecutionPresentation {
  userFacingState: UserFacingExecutionState;
  userFacingLabel: string;
}

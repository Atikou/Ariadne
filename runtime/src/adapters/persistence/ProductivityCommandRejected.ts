/** Rejections are created at precondition checks inside the original owner.
 * They are never inferred from error text or used for uncertain mutations. */
export const PRODUCTIVITY_COMMAND_REJECTIONS = [
  'productivity_command_conflict', 'goal_not_found', 'goal_version_conflict', 'goal_owner_conflict',
  'goal_workflow_still_active', 'goal_autonomy_resume_required', 'goal_autonomy_configuration_locked',
  'goal_autonomy_already_started', 'goal_planner_still_active', 'goal_round_cap_reached',
  'goal_deadline_invalid', 'goal_criterion_duplicate', 'goal_autonomy_not_started',
  'goal_autonomy_not_resumable', 'goal_deadline_exceeded', 'goal_autonomy_unavailable',
  'todo_revision_conflict', 'todo_id_duplicate', 'todo_dependency_duplicate', 'todo_dependency_invalid',
  'todo_dependency_cycle', 'todo_bound_to_running_workflow', 'workflow_goal_autonomy_owned',
  'workflow_goal_unavailable', 'workflow_goal_round_cap_reached', 'workflow_exists',
  'workflow_budget_insufficient', 'workflow_todo_unavailable', 'workflow_deadline_invalid',
  'workflow_dependency_unavailable', 'workflow_agent_result_owned', 'workflow_version_conflict',
  'workflow_completion_not_active', 'workflow_budget_exceeded', 'workflow_not_found',
  'schedule_exists', 'schedule_version_conflict', 'schedule_not_found',
  'schedule_cron_has_no_next_run', 'schedule_occurrence_not_found',
  'schedule_occurrence_version_conflict', 'schedule_occurrence_retry_unavailable'
] as const;
export type ProductivityCommandRejection = typeof PRODUCTIVITY_COMMAND_REJECTIONS[number];
export class ProductivityCommandRejected extends Error {
  public readonly publicCode: string;
  public constructor(public readonly code: ProductivityCommandRejection) {
    super(code); this.name = 'ProductivityCommandRejected';
    this.publicCode = code.endsWith('_version_conflict') || code === 'productivity_command_conflict'
      ? 'productivity_version_conflict' : code;
  }
}

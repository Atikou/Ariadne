import type { ProductivityCommand, ProductivityResult } from '@ariadne/protocol/public';
import type { FrozenConversationContext } from './ConversationContext.js';

export interface ScheduledSubmissionIdentity {
  readonly occurrenceId: string; readonly scheduleId: string; readonly workspaceId: string; readonly sessionId: string;
  readonly prompt: string; readonly dueAt: string; readonly commandId: string; readonly messageId: string; readonly attempts: number;
}

export type ProductivityMutation = Exclude<ProductivityCommand, {
  kind: 'productivity.query' | 'schedules.query' | 'schedule.occurrences.query';
}>;

/** Stable business access contract. Physical SQLite versions are private to the adapter. */
export interface ProductivityAuthority {
  execute(commandId: string, command: ProductivityMutation, now?: Date,
    workflowContext?: FrozenConversationContext): Promise<ProductivityResult>;
  reconcile(commandId: string, command: ProductivityMutation): Promise<ProductivityResult | null>;
  query(workspaceId: string, sessionId: string): Promise<Extract<ProductivityResult, { kind: 'productivity.query_result' }>>;
  querySchedules(workspaceId: string, sessionId: string): Promise<Extract<ProductivityResult, { kind: 'schedules.query_result' }>>;
  queryOccurrences(command: Extract<ProductivityCommand, { kind: 'schedule.occurrences.query' }>):
    Promise<Extract<ProductivityResult, { kind: 'schedule.occurrences.query_result' }>>;
  readOccurrenceIdentity(occurrenceId: string, workspaceId: string, sessionId: string): Promise<ScheduledSubmissionIdentity | null>;
}

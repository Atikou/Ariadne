import { z } from 'zod';
import { publicProjectionCanonicalIdSchema, taskCenterNavigationResultSchema } from '@ariadne/protocol/public';

/** Display identity only. This reference cannot approve, retry or execute a task. */
export const taskNotificationReferenceSchema = z.object({
  runId: publicProjectionCanonicalIdSchema, workspaceId: publicProjectionCanonicalIdSchema,
  sessionId: publicProjectionCanonicalIdSchema, version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  state: z.enum(['completed', 'failed']), sourceStatus: z.string().trim().min(1).max(64)
}).strict();
export type TaskNotificationReference = z.infer<typeof taskNotificationReferenceSchema>;
export const taskNotificationNavigationSchema = taskCenterNavigationResultSchema;
export const notificationNavigationRequestSchema = z.object({ sessionId: publicProjectionCanonicalIdSchema,
  decisionId: publicProjectionCanonicalIdSchema.optional(), taskNavigation: taskNotificationNavigationSchema.optional()
}).strict().superRefine((request, context) => {
  if (request.taskNavigation && (request.decisionId !== undefined || request.taskNavigation.status !== 'ok'
    || request.taskNavigation.target === null || request.sessionId !== request.taskNavigation.target.sessionId
    || request.taskNavigation.reference.source !== 'run' || request.taskNavigation.current?.version !== request.taskNavigation.target.expectedRunVersion
    || request.taskNavigation.target.workspaceId !== request.taskNavigation.workspaceId
    || request.taskNavigation.target.sessionId !== request.taskNavigation.sessionId
    || request.taskNavigation.target.runId !== request.taskNavigation.reference.sourceId))
    context.addIssue({ code: 'custom', message: 'Notification navigation contradicts its validated task target.' });
});

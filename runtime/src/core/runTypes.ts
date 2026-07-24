import { z } from "zod";

/** 顶层 Run 类型；subagent 两项仅用于兼容读取已持久化的历史记录。 */
export const RunKindSchema = z.enum([
  "agent",
  "task",
  "task_dry_run",
  "chat",
  "plan",
  "scheduled",
  "background",
  "subagent",
  "subagent_batch",
]);
export type RunKind = z.infer<typeof RunKindSchema>;

export const RunStatusSchema = z.enum([
  "pending",
  "running",
  "blocked",
  "waiting_confirmation",
  "waiting_plan_handoff",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

const runIdentifier = z.string().min(1);
const runTimestamp = z.string().datetime({ offset: true });

export const RunRecordSchema = z.object({
  id: runIdentifier,
  kind: RunKindSchema,
  status: RunStatusSchema,
  sessionId: runIdentifier.optional(),
  taskId: runIdentifier.optional(),
  parentRunId: runIdentifier.optional(),
  triggerId: runIdentifier.optional(),
  goal: z.string().optional(),
  error: z.string().optional(),
  resultJson: z.string().optional(),
  correlationJson: z.string().optional(),
  createdAt: runTimestamp,
  updatedAt: runTimestamp,
}).strict();
export type RunRecord = z.infer<typeof RunRecordSchema>;

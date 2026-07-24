import { z } from "zod";

import {
  SchedulerTransitionActionSchema,
  TriggerRecordSchema,
} from "./types.js";

export const SchedulerTriggerListResultSchema = z.object({
  triggers: z.array(TriggerRecordSchema),
}).strict();

export const SchedulerTriggerResultSchema = z.object({
  trigger: TriggerRecordSchema,
}).strict();

export const SchedulerErrorResultSchema = z.object({
  error: z.string().min(1),
  code: z.string().min(1),
}).strict();

export const SchedulerTriggerNotFoundResultSchema = z.object({
  error: z.literal("触发器不存在"),
  code: z.literal("SCHEDULER_TRIGGER_NOT_FOUND"),
  triggerId: z.string().min(1),
}).strict();

export const SchedulerTransitionConflictResultSchema = z.object({
  error: z.string().min(1),
  code: z.literal("SCHEDULER_TRIGGER_STATE_CONFLICT"),
  action: SchedulerTransitionActionSchema,
  trigger: TriggerRecordSchema,
}).strict();

export type SchedulerTriggerListResult = z.infer<typeof SchedulerTriggerListResultSchema>;
export type SchedulerTriggerResult = z.infer<typeof SchedulerTriggerResultSchema>;
export type SchedulerErrorResult = z.infer<typeof SchedulerErrorResultSchema>;
export type SchedulerTriggerNotFoundResult = z.infer<typeof SchedulerTriggerNotFoundResultSchema>;
export type SchedulerTransitionConflictResult = z.infer<
  typeof SchedulerTransitionConflictResultSchema
>;

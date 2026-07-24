import { z } from "zod";

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);
export const JsonObjectSchema: z.ZodType<JsonObject> = z.record(JsonValueSchema);

const identifier = z.string().min(1).max(512);
const timestamp = z.string().datetime({ offset: true });

export const NotificationLevelSchema = z.enum(["info", "warn", "error"]);
export type NotificationLevel = z.infer<typeof NotificationLevelSchema>;

export const NotificationPrioritySchema = z.enum(["low", "normal", "high"]);
export type NotificationPriority = z.infer<typeof NotificationPrioritySchema>;

export const NotificationSourceSchema = z.enum([
  "background_task",
  "system",
  "scheduler",
  "subagent",
]);
export type NotificationSource = z.infer<typeof NotificationSourceSchema>;

export const AgentNotificationSchema = z.object({
  id: identifier,
  source: NotificationSourceSchema,
  level: NotificationLevelSchema,
  timestamp,
  message: z.string().min(1),
  priority: NotificationPrioritySchema.optional(),
  taskId: identifier.optional(),
  runId: identifier.optional(),
  dedupeKey: identifier.optional(),
  mergeKey: identifier.optional(),
  payload: JsonObjectSchema.optional(),
  consumed: z.boolean(),
}).strict();
export type AgentNotification = z.infer<typeof AgentNotificationSchema>;

export const NotificationConsumeRecordSchema = z.object({
  op: z.literal("consume"),
  ids: z.array(identifier).min(1).refine((ids) => new Set(ids).size === ids.length, {
    message: "消费记录中的通知 ID 不得重复",
  }),
  time: timestamp,
}).strict();
export type NotificationConsumeRecord = z.infer<typeof NotificationConsumeRecordSchema>;

export const NotificationJournalLineSchema = z.union([
  AgentNotificationSchema,
  NotificationConsumeRecordSchema,
]);
export type NotificationJournalLine = z.infer<typeof NotificationJournalLineSchema>;

export const NotificationListQuerySchema = z.object({
  pending: z.enum(["0", "1"]).optional(),
}).strict();
export type NotificationListQuery = z.infer<typeof NotificationListQuerySchema>;

export const NotificationListResultSchema = z.object({
  notifications: z.array(AgentNotificationSchema),
}).strict();
export type NotificationListResult = z.infer<typeof NotificationListResultSchema>;

export const NotificationConsumeResultSchema = z.object({
  consumed: z.array(AgentNotificationSchema),
}).strict();
export type NotificationConsumeResult = z.infer<typeof NotificationConsumeResultSchema>;

export function normalizeNotificationPayload(
  payload: Record<string, unknown> | undefined,
): JsonObject | undefined {
  if (payload === undefined) return undefined;
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) return undefined;
  return JsonObjectSchema.parse(JSON.parse(serialized));
}

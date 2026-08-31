import { CronPattern } from "croner";
import { z } from "zod";

export const MIN_INTERVAL_MS = 1000;
export const MIN_DEBOUNCE_MS = 100;

export const TriggerStatusSchema = z.enum(["active", "paused", "cancelled", "completed"]);
export type TriggerStatus = z.infer<typeof TriggerStatusSchema>;

const RecurringTriggerStatusSchema = z.enum(["active", "paused", "cancelled"]);

export const TriggerKindSchema = z.enum(["once", "interval", "cron", "event"]);
export type TriggerKind = z.infer<typeof TriggerKindSchema>;

export const MissPolicySchema = z.enum(["skip", "run_once"]);
export type MissPolicy = z.infer<typeof MissPolicySchema>;

export const SchedulerEventTypeSchema = z.enum([
  "file_changed",
  "git_changed",
]);
export type SchedulerEventType = z.infer<typeof SchedulerEventTypeSchema>;

export const CronMissPolicySchema = z.enum(["skip", "run_once"]);
export type CronMissPolicy = z.infer<typeof CronMissPolicySchema>;

const NonBlankTextSchema = z.string().trim().min(1);
const IsoDateTimeSchema = z.string().datetime({ offset: true });
const CronExpressionSchema = NonBlankTextSchema.refine(isValidCronExpression, {
  message: "cron 表达式不合法",
});
const TimeZoneSchema = NonBlankTextSchema.refine(isValidTimeZone, {
  message: "timezone 不是有效的 IANA 时区",
});

export const FileChangedEventFilterSchema = z.object({
  watchPath: NonBlankTextSchema.optional(),
  pattern: NonBlankTextSchema.optional(),
  debounceMs: z.number().int().min(MIN_DEBOUNCE_MS).optional(),
}).strict();

export const GitChangedEventFilterSchema = z.object({
  dirtyOnly: z.boolean().optional(),
  branch: NonBlankTextSchema.optional(),
}).strict();

export const EventFilterSchema = z.union([
  FileChangedEventFilterSchema,
  GitChangedEventFilterSchema,
]);

const TriggerRecordBaseShape = {
  id: NonBlankTextSchema,
  name: NonBlankTextSchema,
  goal: NonBlankTextSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  lastFiredAt: IsoDateTimeSchema.optional(),
  fireCount: z.number().int().nonnegative(),
};

const OnceTriggerRecordSchema = z.object({
  ...TriggerRecordBaseShape,
  kind: z.literal("once"),
  status: TriggerStatusSchema,
  at: IsoDateTimeSchema,
  missPolicy: MissPolicySchema.optional(),
}).strict();

const IntervalTriggerRecordSchema = z.object({
  ...TriggerRecordBaseShape,
  kind: z.literal("interval"),
  status: RecurringTriggerStatusSchema,
  intervalMs: z.number().int().min(MIN_INTERVAL_MS),
}).strict();

const CronTriggerRecordSchema = z.object({
  ...TriggerRecordBaseShape,
  kind: z.literal("cron"),
  status: RecurringTriggerStatusSchema,
  cron: CronExpressionSchema,
  timezone: TimeZoneSchema.optional(),
  cronMissPolicy: CronMissPolicySchema.optional(),
}).strict();

const FileChangedTriggerRecordSchema = z.object({
  ...TriggerRecordBaseShape,
  kind: z.literal("event"),
  status: RecurringTriggerStatusSchema,
  eventType: z.literal("file_changed"),
  eventFilter: FileChangedEventFilterSchema.optional(),
}).strict();

const GitChangedTriggerRecordSchema = z.object({
  ...TriggerRecordBaseShape,
  kind: z.literal("event"),
  status: RecurringTriggerStatusSchema,
  eventType: z.literal("git_changed"),
  eventFilter: GitChangedEventFilterSchema.optional(),
}).strict();

export const TriggerRecordSchema = z.union([
  OnceTriggerRecordSchema,
  IntervalTriggerRecordSchema,
  CronTriggerRecordSchema,
  FileChangedTriggerRecordSchema,
  GitChangedTriggerRecordSchema,
]);
export type TriggerRecord = z.infer<typeof TriggerRecordSchema>;

export const TriggerJournalUpsertSchema = z.object({
  op: z.literal("upsert"),
  time: IsoDateTimeSchema,
  trigger: TriggerRecordSchema,
}).strict();

export const TriggerJournalDeleteSchema = z.object({
  op: z.literal("delete"),
  time: IsoDateTimeSchema,
  id: NonBlankTextSchema,
}).strict();

export const TriggerJournalLineSchema = z.union([
  TriggerJournalUpsertSchema,
  TriggerJournalDeleteSchema,
]);
export type TriggerJournalLine = z.infer<typeof TriggerJournalLineSchema>;

function isValidCronExpression(value: string): boolean {
  try {
    new CronPattern(value);
    return true;
  } catch {
    return false;
  }
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

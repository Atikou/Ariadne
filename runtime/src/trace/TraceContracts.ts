import { z } from "zod";

import {
  TRACE_REPLAY_CATEGORIES,
  type TraceQueryFilter,
} from "./traceReplayTypes.js";
import { RUN_TIMELINE_CATEGORIES } from "./traceTimelineTypes.js";

const identifier = z.string().trim().min(1).max(512);
const eventType = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
const nonNegativeInteger = z.number().int().nonnegative();

export const TraceReplayCategorySchema = z.enum(TRACE_REPLAY_CATEGORIES);

function queryLimit(defaultValue: number, maximum: number) {
  return z
    .string()
    .regex(/^[1-9][0-9]*$/, "limit 必须是正整数")
    .transform(Number)
    .pipe(z.number().int().min(1).max(maximum))
    .optional()
    .transform((value) => value ?? defaultValue);
}

const queryBoolean = z
  .enum(["true", "false"])
  .optional()
  .transform((value) => value !== "false");

const eventTypesQuery = z
  .string()
  .max(2_048)
  .transform((value, context) => {
    const values = value.split(",").map((item) => item.trim());
    if (values.length === 0 || values.some((item) => !eventType.safeParse(item).success)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "types 必须是 1 至 20 个逗号分隔的有效事件类型",
      });
    }
    if (values.length > 20) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "types 最多包含 20 个事件类型",
      });
    }
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "types 不得包含重复事件类型",
      });
    }
    return values;
  });

const filteredQueryShape = {
  runId: identifier.optional(),
  sessionId: identifier.optional(),
  taskId: identifier.optional(),
  toolCallId: identifier.optional(),
  type: eventType.optional(),
  types: eventTypesQuery.optional(),
  category: TraceReplayCategorySchema.optional(),
  replayOnly: queryBoolean,
};

function filteredQuerySchema(defaultLimit: number, maximum: number) {
  return z
    .object({
      ...filteredQueryShape,
      limit: queryLimit(defaultLimit, maximum),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.type && value.types) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["types"],
          message: "type 与 types 不能同时提供",
        });
      }
    })
    .transform((value) => ({
      limit: value.limit,
      filter: compactFilter(value),
    }));
}

function compactFilter(value: {
  runId?: string;
  sessionId?: string;
  taskId?: string;
  toolCallId?: string;
  type?: string;
  types?: string[];
  category?: z.infer<typeof TraceReplayCategorySchema>;
  replayOnly: boolean;
}): TraceQueryFilter {
  return {
    ...(value.runId ? { runId: value.runId } : {}),
    ...(value.sessionId ? { sessionId: value.sessionId } : {}),
    ...(value.taskId ? { taskId: value.taskId } : {}),
    ...(value.toolCallId ? { toolCallId: value.toolCallId } : {}),
    ...(value.type ? { type: value.type } : {}),
    ...(value.types ? { types: value.types } : {}),
    ...(value.category ? { category: value.category } : {}),
    replayOnly: value.replayOnly,
  };
}

export const TraceRecentQuerySchema = z
  .object({ limit: queryLimit(50, 200) })
  .strict();
export const TraceReplayQuerySchema = filteredQuerySchema(100, 500);
export const TraceExportQuerySchema = filteredQuerySchema(500, 2_000);

export type TraceJsonValue =
  | string
  | number
  | boolean
  | null
  | TraceJsonValue[]
  | { [key: string]: TraceJsonValue };

export const TraceJsonValueSchema: z.ZodType<TraceJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(TraceJsonValueSchema),
    z.record(z.string(), TraceJsonValueSchema),
  ]),
);

export const TracePublicEventSchema = z
  .object({
    type: eventType,
    time: z.string().optional(),
    eventId: identifier.optional(),
  })
  .catchall(TraceJsonValueSchema);

export const TraceFilterProjectionSchema = z
  .object({
    runId: identifier.optional(),
    sessionId: identifier.optional(),
    taskId: identifier.optional(),
    toolCallId: identifier.optional(),
    type: eventType.optional(),
    types: z.array(eventType).min(1).max(20).optional(),
    category: TraceReplayCategorySchema.optional(),
    replayOnly: z.literal(false).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.type && value.types) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["types"],
        message: "type 与 types 不能同时出现",
      });
    }
    if (value.types && new Set(value.types).size !== value.types.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["types"],
        message: "types 不得重复",
      });
    }
  });

const uniqueIdentifiers = z.array(identifier).refine(
  (values) => new Set(values).size === values.length,
  "身份列表不得重复",
);

export const TraceQuerySummarySchema = z
  .object({
    types: z.record(z.string(), nonNegativeInteger),
    toolCallIds: uniqueIdentifiers,
    runIds: uniqueIdentifiers,
    sessionIds: uniqueIdentifiers,
  })
  .strict();

const timelineRefValue = z.union([z.string(), z.number().finite(), z.boolean()]);

export const TraceTimelineCategorySchema = z.enum(RUN_TIMELINE_CATEGORIES);

export const TraceTimelineEntrySchema = z
  .object({
    time: z.string(),
    category: TraceTimelineCategorySchema,
    type: eventType,
    title: z.string(),
    status: z.string().optional(),
    detail: z.string().optional(),
    refs: z.record(z.string(), timelineRefValue.optional()).optional(),
  })
  .strict();

const traceListShape = {
  events: z.array(TracePublicEventSchema),
  count: nonNegativeInteger,
  redacted: z.literal(true),
};

function bindEventCount<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  return schema.superRefine((value, context) => {
    const candidate = value as { events?: unknown[]; count?: number };
    if (candidate.events && candidate.count !== candidate.events.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["count"],
        message: "count 必须等于 events 长度",
      });
    }
  });
}

export const TraceListResultSchema = bindEventCount(
  z.object(traceListShape).strict(),
);

export const TraceReplayResultSchema = bindEventCount(
  z
    .object({
      ...traceListShape,
      replay: z.literal(true),
      filters: TraceFilterProjectionSchema,
      summary: TraceQuerySummarySchema,
      timeline: z.array(TraceTimelineEntrySchema),
    })
    .strict(),
);

export const TraceExportResultSchema = bindEventCount(
  z
    .object({
      ...traceListShape,
      exportedAt: z.string().datetime({ offset: true }),
      filters: TraceFilterProjectionSchema,
      summary: TraceQuerySummarySchema,
      timeline: z.array(TraceTimelineEntrySchema),
    })
    .strict(),
);

const traceSegmentPath = z
  .string()
  .regex(/^segments\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/)
  .refine((value) => !value.split("/").includes(".."), "segmentPath 必须是安全相对路径");

const traceRotateCommon = {
  activeSegment: z.literal("active/trace-current.jsonl"),
  indexEntries: nonNegativeInteger,
};

export const TraceRotateResultSchema = z.discriminatedUnion("rotated", [
  z
    .object({
      rotated: z.literal(true),
      segmentPath: traceSegmentPath,
      ...traceRotateCommon,
    })
    .strict(),
  z
    .object({
      rotated: z.literal(false),
      ...traceRotateCommon,
    })
    .strict(),
]);

export const TraceQueryErrorResultSchema = z
  .object({
    error: z.string(),
    code: z.literal("TRACE_QUERY_INVALID"),
  })
  .strict();

export const TraceReadErrorResultSchema = z
  .object({
    error: z.string(),
    code: z.literal("TRACE_READ_FAILED"),
  })
  .strict();

export const TraceRotateErrorResultSchema = z
  .object({
    error: z.string(),
    code: z.literal("TRACE_ROTATE_FAILED"),
  })
  .strict();

export const TraceOperationErrorResultSchema = z.union([
  TraceReadErrorResultSchema,
  TraceRotateErrorResultSchema,
]);

export type TracePublicEvent = z.infer<typeof TracePublicEventSchema>;

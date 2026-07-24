import { z } from "zod";

import { PlanReportRequestHintSchema } from "./planIntent.js";
import { PlanModeSchema, PublicPlanJsonSchema } from "./types.js";

const nonBlankString = z.string().trim().min(1);
const positiveInteger = z.number().int().positive();

export const PlanDraftRequestSchema = z
  .object({
    goal: nonBlankString,
    context: z.string().optional(),
    sessionId: nonBlankString.optional(),
    mode: PlanModeSchema.optional(),
    clientName: nonBlankString.optional(),
  })
  .strict();

export const PlanImportPreviewRequestSchema = z
  .object({
    preview: z.union([PublicPlanJsonSchema, nonBlankString]),
    goal: nonBlankString.optional(),
    sessionId: nonBlankString.optional(),
    clientName: nonBlankString.optional(),
    planId: nonBlankString.optional(),
    baseVersion: positiveInteger.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.baseVersion !== undefined && value.planId === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baseVersion"],
        message: "baseVersion 只能与 planId 一起使用",
      });
    }
  });

export const PlanReviseRequestSchema = z
  .object({
    baseVersion: positiveInteger.optional(),
    revisionRequest: nonBlankString,
    sessionId: nonBlankString.optional(),
    clientName: nonBlankString.optional(),
  })
  .strict();

export const PlanCompileRequestSchema = z
  .object({
    confirmedTodoIds: z
      .array(nonBlankString)
      .min(1)
      .refine((ids) => new Set(ids).size === ids.length, "confirmedTodoIds 不得重复"),
    sessionId: nonBlankString.optional(),
  })
  .strict();

const planDraftResultShape = {
  planId: z.string(),
  version: positiveInteger,
  status: z.literal("awaiting_approval"),
  planHash: z.string(),
  previewMarkdown: z.string(),
  publicPlanJson: PublicPlanJsonSchema,
};

export const PlanDraftResultSchema = z
  .object({
    runId: z.string().uuid(),
    ...planDraftResultShape,
    warning: z.string(),
    nextAction: z
      .object({
        approve: z.string(),
        execute: z.string(),
      })
      .strict(),
  })
  .strict();

export const PlanImportPreviewResultSchema = z
  .object({
    ...planDraftResultShape,
    supersededVersion: positiveInteger.optional(),
  })
  .strict();

export const PlanRevisionResultSchema = z
  .object({
    ...planDraftResultShape,
    supersededVersion: positiveInteger,
    warning: z.string(),
  })
  .strict();

export const PlanCompileResultSchema = z
  .object({
    ...planDraftResultShape,
    sourceUserVisiblePlanId: z.string(),
    warning: z.string(),
  })
  .strict();

export const PlanOperationErrorResultSchema = z
  .object({
    error: z.string(),
    code: z.string(),
  })
  .strict();

export const PlanDraftRunErrorResultSchema = z
  .object({
    error: z.string(),
    code: z.string(),
    runId: z.string().uuid(),
  })
  .strict();

export const PlanDraftInvalidResultSchema = z.union([
  PlanOperationErrorResultSchema,
  PlanDraftRunErrorResultSchema,
  PlanReportRequestHintSchema,
]);

export const PlanOperationNotFoundResultSchema = z
  .object({
    error: z.string(),
    code: z.enum(["PLAN_NOT_FOUND", "MODEL_CLIENT_NOT_FOUND"]),
  })
  .strict();

export const PlanOperationConflictResultSchema = z
  .object({
    error: z.string(),
    code: z.literal("PLAN_STATUS_CONFLICT"),
  })
  .strict();

export type PlanDraftRequest = z.infer<typeof PlanDraftRequestSchema>;
export type PlanImportPreviewRequest = z.infer<typeof PlanImportPreviewRequestSchema>;
export type PlanReviseRequest = z.infer<typeof PlanReviseRequestSchema>;
export type PlanCompileRequest = z.infer<typeof PlanCompileRequestSchema>;

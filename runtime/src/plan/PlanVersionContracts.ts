import { z } from "zod";

import { PlanStatusSchema } from "./types.js";

const positiveIntegerText = z
  .string()
  .regex(/^[1-9]\d*$/, "必须为正整数")
  .transform(Number)
  .refine(Number.isSafeInteger, "超出安全整数范围");

export const PlanPreviewQuerySchema = z
  .object({
    version: positiveIntegerText.default(1),
    format: z.enum(["markdown", "json"]).default("markdown"),
  })
  .strict();

export const PlanApproveRequestSchema = z
  .object({
    version: z.number().int().positive().optional(),
    comment: z.string().optional(),
    approvedBy: z.string().optional(),
  })
  .strict();

export const PlanRejectRequestSchema = z
  .object({
    version: z.number().int().positive().optional(),
    comment: z.string().optional(),
    rejectedBy: z.string().optional(),
  })
  .strict();

export const PlanVersionSummarySchema = z
  .object({
    version: z.number().int().positive(),
    status: PlanStatusSchema,
    planHash: z.string(),
    changeReason: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict();

export const PlanSummaryResultSchema = z
  .object({
    planId: z.string(),
    latestVersion: z.number().int().positive(),
    status: PlanStatusSchema,
    goal: z.string(),
    versions: z.array(PlanVersionSummarySchema),
  })
  .strict();

export const PlanPreviewResultSchema = z
  .object({
    planId: z.string(),
    version: z.number().int().positive(),
    format: z.enum(["markdown", "json"]),
    content: z.string(),
    executable: z.literal(false),
  })
  .strict();

const planDecisionResultShape = {
  planId: z.string(),
  version: z.number().int().positive(),
  planHash: z.string(),
};

export const PlanApprovedResultSchema = z
  .object({ ...planDecisionResultShape, status: z.literal("approved") })
  .strict();

export const PlanRejectedResultSchema = z
  .object({ ...planDecisionResultShape, status: z.literal("rejected") })
  .strict();

export const PlanInvalidQueryResultSchema = z
  .object({
    error: z.string(),
    code: z.literal("INVALID_QUERY"),
  })
  .strict();

export const PlanNotFoundResultSchema = z
  .object({
    error: z.string(),
    code: z.literal("PLAN_NOT_FOUND"),
  })
  .strict();

export const PlanStatusConflictResultSchema = z
  .object({
    error: z.string(),
    code: z.literal("PLAN_STATUS_CONFLICT"),
  })
  .strict();

export const PlanInternalErrorResultSchema = z
  .object({
    error: z.string(),
    code: z.string(),
  })
  .strict();

export type PlanPreviewQuery = z.infer<typeof PlanPreviewQuerySchema>;
export type PlanApproveRequest = z.infer<typeof PlanApproveRequestSchema>;
export type PlanRejectRequest = z.infer<typeof PlanRejectRequestSchema>;

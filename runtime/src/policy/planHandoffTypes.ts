import { z } from "zod";
import { AgentPlanContractSchema } from "../plan/AgentPlanContract.js";

/** 计划→执行交接协议（与工具级 permissionRequest 分离）。 */
export const PLAN_HANDOFF_SCHEMA_VERSION = 1 as const;

const nonEmptyString = z.string().trim().min(1);
const nonBlankText = z.string().min(1).refine((value) => value.trim().length > 0, {
  message: "不得只包含空白字符",
});
const timestamp = z.string().datetime();

export const PlanHandoffStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
]);
export type PlanHandoffStatus = z.infer<typeof PlanHandoffStatusSchema>;

export const PlanHandoffDecisionSchema = z.enum(["approve", "reject"]);
export type PlanHandoffDecision = z.infer<typeof PlanHandoffDecisionSchema>;

export const PlanHandoffVariantSchema = z.enum([
  "plan_only",
  "plan_wait_approval",
  "plan_then_execute",
]);
export type PlanHandoffVariant = z.infer<typeof PlanHandoffVariantSchema>;

const planHandoffCommonFields = {
  schemaVersion: z.literal(PLAN_HANDOFF_SCHEMA_VERSION),
  id: nonEmptyString,
  planId: nonEmptyString,
  runId: nonEmptyString,
  sessionId: nonEmptyString.optional(),
  resumeMode: z.literal("implement"),
  message: nonBlankText,
  planVariant: PlanHandoffVariantSchema,
  planMarkdown: nonBlankText,
  plan: AgentPlanContractSchema.optional(),
  planVersion: z.number().int().positive().optional(),
  createdAt: timestamp,
};

export const PlanHandoffPendingPayloadSchema = z
  .object({
    ...planHandoffCommonFields,
    status: z.literal("pending"),
  })
  .strict();

export const PlanHandoffApprovedPayloadSchema = z
  .object({
    ...planHandoffCommonFields,
    status: z.literal("approved"),
    respondedAt: timestamp,
    decision: z.literal("approve"),
  })
  .strict();

export const PlanHandoffRejectedPayloadSchema = z
  .object({
    ...planHandoffCommonFields,
    status: z.literal("rejected"),
    respondedAt: timestamp,
    decision: z.literal("reject"),
  })
  .strict();

export const PlanHandoffPayloadSchema = z.discriminatedUnion("status", [
  PlanHandoffPendingPayloadSchema,
  PlanHandoffApprovedPayloadSchema,
  PlanHandoffRejectedPayloadSchema,
]);
export type PlanHandoffPayload = z.infer<typeof PlanHandoffPayloadSchema>;

export const PlanHandoffCreateInputSchema = z
  .object({
    runId: nonEmptyString,
    sessionId: nonEmptyString.optional(),
    plan: AgentPlanContractSchema,
    planVariant: PlanHandoffVariantSchema,
    message: nonBlankText,
  })
  .strict();
export type PlanHandoffCreateInput = z.infer<typeof PlanHandoffCreateInputSchema>;

export const PlanHandoffRespondInputSchema = z
  .object({ decision: PlanHandoffDecisionSchema })
  .strict();
export type PlanHandoffRespondInput = z.infer<typeof PlanHandoffRespondInputSchema>;

export const PlanHandoffListFilterSchema = z
  .object({
    sessionId: nonEmptyString.optional(),
    runId: nonEmptyString.optional(),
  })
  .strict();
export type PlanHandoffListFilter = z.infer<typeof PlanHandoffListFilterSchema>;

import { z } from "zod";

import { AgentExecutionOutcomeSchema } from "../assistant/AgentHandoffContracts.js";
import { CompanionSafetyResultSchema } from "./CompanionSafetyContracts.js";
import {
  CompanionMessageSchema,
  CompanionSummaryStatusSchema,
} from "./CompanionSessionContracts.js";

const identifier = z.string().trim().min(1).max(1_024);
const outcomeStatus = AgentExecutionOutcomeSchema.shape.status;

export const CompanionAgentResultPresentedSchema = z.object({
  status: z.literal("presented"),
  projectionKey: identifier,
  outcomeStatus,
  source: z.enum(["model", "fallback"]),
  reused: z.boolean(),
  message: CompanionMessageSchema.extend({
    role: z.literal("assistant"),
    status: z.literal("completed"),
  }),
  summaryStatus: CompanionSummaryStatusSchema,
  safety: CompanionSafetyResultSchema,
}).strict();
export type CompanionAgentResultPresented = z.infer<
  typeof CompanionAgentResultPresentedSchema
>;

export const CompanionAgentResultDeliverySchema = z.discriminatedUnion("status", [
  CompanionAgentResultPresentedSchema,
  z.object({
    status: z.literal("failed"),
    outcomeStatus,
    code: z.string().trim().min(1).max(200),
    message: z.string().trim().min(1).max(1_000),
  }).strict(),
]);
export type CompanionAgentResultDelivery = z.infer<
  typeof CompanionAgentResultDeliverySchema
>;

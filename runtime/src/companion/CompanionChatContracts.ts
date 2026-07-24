import { z } from "zod";

import { RoutingStrategySchema } from "../config/types.js";
import { CompanionOutputModeSchema } from "./CompanionMemoryContracts.js";
import {
  CompanionAgentProposalSubmissionResultShape,
  addCompanionAgentProposalSubmissionIssues,
} from "./CompanionAgentProposalOutboxContracts.js";
import { CompanionSafetyResultSchema } from "./CompanionSafetyContracts.js";
import {
  CompanionMessageSchema,
  CompanionSessionSchema,
  CompanionStorageStatusSchema,
  CompanionSummaryStatusSchema,
} from "./CompanionSessionContracts.js";
import { CompanionVectorStatusSchema } from "./CompanionVectorContracts.js";

const nonEmptyIdentifier = z.string().trim().min(1);
const originalMessage = z.string().min(1).max(32_000).refine(
  (value) => value.trim().length > 0,
  { message: "message 不能为空白" },
);

const ModelInferenceOptionsSchema = z.object({
  reasoningMode: z.enum(["off", "on", "auto", "pro"]).optional(),
  reasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh", "max"]).optional(),
}).strict();

export const CompanionChatRequestSchema = z.object({
  message: originalMessage,
  userMessageId: nonEmptyIdentifier.optional(),
  sessionId: nonEmptyIdentifier.optional(),
  clientName: nonEmptyIdentifier.optional(),
  storageRoot: nonEmptyIdentifier.optional(),
  personaId: nonEmptyIdentifier.optional(),
  workspaceKey: nonEmptyIdentifier.optional(),
  incognito: z.boolean().optional(),
  outputMode: CompanionOutputModeSchema.optional(),
  inference: ModelInferenceOptionsSchema.optional(),
  routingStrategy: RoutingStrategySchema.optional(),
}).strict().superRefine((input, ctx) => {
  if (input.incognito !== true || input.sessionId === undefined) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: "incognito 聊天不能引用持久化 sessionId",
    path: ["sessionId"],
  });
});
export type CompanionChatInput = z.infer<typeof CompanionChatRequestSchema>;

export { CompanionSafetyResultSchema } from "./CompanionSafetyContracts.js";
export type { CompanionSafetyResult } from "./CompanionSafetyContracts.js";

export const CompanionChatRetrievalSchema = z.object({
  memoryCount: z.number().int().nonnegative(),
  summaryCount: z.number().int().nonnegative(),
}).strict();

export const CompanionChatMessageResponseSchema = z.object({
  type: z.literal("message"),
}).strict();

export const CompanionChatAgentProposalResponseSchema = z.object({
  type: z.literal("agent_proposal"),
  ...CompanionAgentProposalSubmissionResultShape,
}).strict().superRefine((response, ctx) => {
  addCompanionAgentProposalSubmissionIssues(response, ctx);
});

export const CompanionChatResponseSchema = z.union([
  CompanionChatMessageResponseSchema,
  CompanionChatAgentProposalResponseSchema,
]);
export type CompanionChatResponse = z.infer<typeof CompanionChatResponseSchema>;

const chatResultBase = {
  content: z.string(),
  storage: CompanionStorageStatusSchema,
  safety: CompanionSafetyResultSchema,
  summaryStatus: CompanionSummaryStatusSchema,
  vector: CompanionVectorStatusSchema,
  retrieval: CompanionChatRetrievalSchema,
  response: CompanionChatResponseSchema,
};

export const CompanionStoredChatResultSchema = z.object({
  persistence: z.literal("stored"),
  ...chatResultBase,
  session: CompanionSessionSchema.extend({ incognito: z.literal(false) }),
  userMessage: CompanionMessageSchema.extend({
    role: z.literal("user"),
    status: z.literal("completed"),
  }),
  assistantMessage: CompanionMessageSchema.extend({
    role: z.literal("assistant"),
    status: z.literal("completed"),
  }),
}).strict();

export const CompanionIncognitoChatResultSchema = z.object({
  persistence: z.literal("incognito"),
  ...chatResultBase,
  session: z.undefined().optional(),
  userMessage: z.undefined().optional(),
  assistantMessage: z.undefined().optional(),
  response: CompanionChatMessageResponseSchema,
  summaryStatus: z.object({
    generated: z.literal(false),
    reason: z.literal("incognito"),
  }).strict(),
}).strict();

export const CompanionChatResultSchema = z.discriminatedUnion("persistence", [
  CompanionStoredChatResultSchema,
  CompanionIncognitoChatResultSchema,
]).superRefine((result, ctx) => {
  if (result.content !== result.safety.content) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "公开 content 必须与 safety.content 一致",
      path: ["content"],
    });
  }
  if (result.persistence !== "stored") return;
  if (result.assistantMessage.content !== result.content) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "assistantMessage.content 必须与公开 content 一致",
      path: ["assistantMessage", "content"],
    });
  }
  if (result.response.type === "agent_proposal") {
    const proposal = result.response.proposal;
    for (const [path, actual, expected] of [
      [["response", "proposal", "sourceTurnId"], proposal.sourceTurnId, result.userMessage.id],
      [["response", "proposal", "companionSessionId"], proposal.companionSessionId, result.session.id],
      [["response", "proposal", "originalRequest"], proposal.originalRequest, result.userMessage.content],
      [["content"], result.content, proposal.reason],
    ] as const) {
      if (actual === expected) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Agent 提案必须绑定本轮真实消息、会话与公开原因",
        path: [...path],
      });
    }
  }
  for (const [field, sessionId] of [
    ["userMessage", result.userMessage.sessionId],
    ["assistantMessage", result.assistantMessage.sessionId],
  ] as const) {
    if (sessionId === result.session.id) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${field}.sessionId 必须指向返回的 session`,
      path: [field, "sessionId"],
    });
  }
});
export type CompanionChatResult = z.infer<typeof CompanionChatResultSchema>;

export const CompanionChatResourceSchema = z.enum(["client", "session", "persona"]);
export type CompanionChatResource = z.infer<typeof CompanionChatResourceSchema>;

export class CompanionChatResourceNotFoundError extends Error {
  readonly code = "COMPANION_CHAT_RESOURCE_NOT_FOUND";

  constructor(
    readonly resource: Exclude<CompanionChatResource, "client">,
    readonly resourceId: string,
  ) {
    super(resource === "session"
      ? `Companion 会话不存在：${resourceId}`
      : `Companion 人格不存在或未启用：${resourceId}`);
    this.name = "CompanionChatResourceNotFoundError";
  }
}

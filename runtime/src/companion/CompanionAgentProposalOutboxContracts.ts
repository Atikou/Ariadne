import { z } from "zod";

import { AgentProposalDraftSchema } from "../assistant/AgentProposalDraftContracts.js";
import {
  AgentProposalSchema,
  AgentSessionReadGrantSchema,
} from "../assistant/AgentHandoffContracts.js";
import { CompanionAgentResultDeliverySchema } from "./CompanionAgentResultContracts.js";

const identifier = z.string().trim().min(1).max(1_024);
const originalRequest = z.string().min(1).max(32_000).refine(
  (value) => value.trim().length > 0,
  { message: "originalRequest 不能为空白" },
);

export const CompanionAgentProposalSourceSchema = z.object({
  protocolVersion: z.string().trim().min(1).max(32),
  transport: z.enum(["tool_call", "text_envelope"]),
  selectionMode: z.enum(["automatic", "manual"]).optional(),
  requestedClientName: identifier.optional(),
  clientName: identifier,
  modelName: identifier,
  responseHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict().superRefine((source, ctx) => {
  if (source.selectionMode === "manual" && !source.requestedClientName) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "手动模型选择必须记录 requestedClientName",
      path: ["requestedClientName"],
    });
  }
  if (
    source.selectionMode === "manual"
    && source.requestedClientName
    && source.requestedClientName !== source.clientName
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "手动选择的模型客户端与实际响应客户端不一致",
      path: ["clientName"],
    });
  }
});

/** Durable data needed to recreate the exact Companion-to-Agent proposal submission. */
export const CompanionAgentProposalOutboxPayloadSchema = z.object({
  sourceTurnId: identifier,
  companionSessionId: identifier,
  originalRequest,
  workspaceKey: identifier.optional(),
  draft: AgentProposalDraftSchema,
  source: CompanionAgentProposalSourceSchema.optional(),
}).strict();
export type CompanionAgentProposalOutboxPayload = z.infer<
  typeof CompanionAgentProposalOutboxPayloadSchema
>;

export interface CompanionAgentProposalSubmission
  extends CompanionAgentProposalOutboxPayload {
  companionStorageRoot: string;
}

const CompanionAgentProposalSubmissionResultBaseSchema = z.object({
  proposal: AgentProposalSchema,
  sessionReadGrant: AgentSessionReadGrantSchema.optional(),
  companionPresentation: CompanionAgentResultDeliverySchema.optional(),
}).strict();

export const CompanionAgentProposalSubmissionResultSchema =
  CompanionAgentProposalSubmissionResultBaseSchema.superRefine(
    addCompanionAgentProposalSubmissionIssues,
  );
export type CompanionAgentProposalSubmissionResult = z.infer<
  typeof CompanionAgentProposalSubmissionResultBaseSchema
>;

export function addCompanionAgentProposalSubmissionIssues(
  result: CompanionAgentProposalSubmissionResult,
  ctx: z.RefinementCtx,
): void {
  const { proposal, sessionReadGrant, companionPresentation } = result;
  if (proposal.status === "pending") {
    if (sessionReadGrant || companionPresentation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "pending 提案不能伪装成已使用会话授权或已生成 Agent 结果",
      });
    }
    return;
  }
  if (!["waiting_permission", "waiting_plan_handoff", "completed", "failed"].includes(proposal.status)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Companion 提案投递不能暴露中间授权或执行状态",
      path: ["proposal", "status"],
    });
    return;
  }
  if (!sessionReadGrant || !companionPresentation || !proposal.outcome) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "自动执行的只读提案必须携带会话授权和最终表达投递状态",
    });
    return;
  }
  if (
    sessionReadGrant.status !== "active"
    || proposal.companionSessionId !== sessionReadGrant.companionSessionId
    || proposal.workspaceKey !== sessionReadGrant.workspaceKey
    || proposal.requestedScope.length !== sessionReadGrant.allowedScope.length
    || proposal.requestedScope.some((scope) => !sessionReadGrant.allowedScope.includes(scope))
    || proposal.risk !== "read-only"
    || proposal.requestedCapabilities.length !== 1
    || proposal.requestedCapabilities[0] !== "file-read"
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "自动执行只能复用当前会话和工作区的 file-read 授权",
      path: ["sessionReadGrant"],
    });
  }
  if (companionPresentation.outcomeStatus !== proposal.outcome.status) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Companion 最终表达状态必须与 Agent 结构化结果一致",
      path: ["companionPresentation", "outcomeStatus"],
    });
  }
}

export const CompanionAgentProposalSubmissionResultShape =
  CompanionAgentProposalSubmissionResultBaseSchema.shape;

export const CompanionAgentProposalOutboxStateSchema = z.enum([
  "pending",
  "dispatching",
  "delivered",
  "failed",
]);
export type CompanionAgentProposalOutboxState = z.infer<
  typeof CompanionAgentProposalOutboxStateSchema
>;

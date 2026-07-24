import { z } from "zod";

import { TOOL_PERMISSION_VALUES, type ToolPermission } from "../core/permissions.js";
import {
  AgentCapabilityListSchema,
  AgentProposalRiskSchema,
  type AgentCapability,
} from "./AgentProposalDraftContracts.js";

export {
  AgentCapabilityListSchema,
  AgentCapabilitySchema,
  AgentProposalDraftSchema,
  AgentProposalRiskSchema,
} from "./AgentProposalDraftContracts.js";
export type {
  AgentCapability,
  AgentProposalDraft,
  AgentProposalRisk,
} from "./AgentProposalDraftContracts.js";

export const AGENT_HANDOFF_SCHEMA_VERSION = 1 as const;

const identifier = z.string().trim().min(1).max(200);
const boundedText = (max: number) => z.string().trim().min(1).max(max);
const originalText = (max: number) => z.string().min(1).max(max).refine(
  (value) => value.trim().length > 0,
  { message: "原始请求不能为空白" },
);
const timestamp = z.string().datetime();

export const AgentProposalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "executing",
  "waiting_permission",
  "waiting_plan_handoff",
  "completed",
  "failed",
]);
export type AgentProposalStatus = z.infer<typeof AgentProposalStatusSchema>;

export const AgentGrantStatusSchema = z.enum(["active", "consumed", "revoked"]);
export type AgentGrantStatus = z.infer<typeof AgentGrantStatusSchema>;

const uniqueScopes = z.array(boundedText(1_024)).min(1).max(16).superRefine((items, ctx) => {
  const normalized = items.map((item) => item.toLocaleLowerCase());
  if (new Set(normalized).size !== normalized.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "作用域不能重复" });
  }
});

export const AgentProposalCreateInputSchema = z.object({
  sourceTurnId: identifier,
  companionSessionId: identifier.optional(),
  reason: boundedText(2_000),
  originalRequest: originalText(32_000),
  interpretedTask: boundedText(8_000),
  requestedCapabilities: AgentCapabilityListSchema,
  requestedScope: uniqueScopes,
  risk: AgentProposalRiskSchema,
  workspaceKey: identifier,
}).strict().superRefine((proposal, ctx) => {
  if (
    proposal.risk === "read-only"
    && proposal.requestedCapabilities.some((capability) =>
      capability === "file-write" || capability === "shell")
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "包含写入或命令能力的提案不能声明为只读风险",
      path: ["risk"],
    });
  }
});
export type AgentProposalCreateInput = z.infer<typeof AgentProposalCreateInputSchema>;

export const ExplicitAgentProposalRequestSchema = z.object({
  sourceTurnId: identifier,
  companionSessionId: identifier.optional(),
  originalRequest: originalText(32_000),
  requestedCapabilities: AgentCapabilityListSchema,
  workspaceKey: identifier.optional(),
}).strict();
export type ExplicitAgentProposalRequest = z.infer<typeof ExplicitAgentProposalRequestSchema>;

export const AgentExecutionOutcomeSchema = z.object({
  status: z.enum([
    "completed",
    "waiting_permission",
    "waiting_plan_handoff",
    "failed",
  ]),
  answer: z.string().max(32_000).optional(),
  error: z.string().max(2_000).optional(),
  facts: z.array(z.string().min(1).max(1_000)).max(100).optional(),
  files: z.array(z.object({
    path: z.string().min(1).max(2_048),
    tool: identifier,
    operation: z.enum(["read", "write", "dangerous"]),
  }).strict()).max(100).optional(),
  errors: z.array(z.object({
    tool: identifier.optional(),
    message: z.string().min(1).max(2_000),
  }).strict()).max(100).optional(),
  taskId: identifier.optional(),
  permissionRequestId: identifier.optional(),
  planHandoffId: identifier.optional(),
}).strict();
export type AgentExecutionOutcome = z.infer<typeof AgentExecutionOutcomeSchema>;

export const AgentProposalSchema = z.object({
  schemaVersion: z.literal(AGENT_HANDOFF_SCHEMA_VERSION),
  id: identifier,
  sourceTurnId: identifier,
  companionSessionId: identifier.optional(),
  agentSessionId: identifier.optional(),
  reason: boundedText(2_000),
  originalRequest: originalText(32_000),
  interpretedTask: boundedText(8_000),
  requestedCapabilities: AgentCapabilityListSchema,
  requestedScope: uniqueScopes,
  risk: AgentProposalRiskSchema,
  workspaceKey: identifier,
  status: AgentProposalStatusSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
  respondedAt: timestamp.optional(),
  grantId: identifier.optional(),
  runId: identifier.optional(),
  outcome: AgentExecutionOutcomeSchema.optional(),
}).strict().superRefine((proposal, ctx) => {
  if (
    proposal.risk === "read-only"
    && proposal.requestedCapabilities.some((capability) =>
      capability === "file-write" || capability === "shell")
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "包含写入或命令能力的提案不能声明为只读风险",
      path: ["risk"],
    });
  }
  if (proposal.status === "pending") {
    for (const field of ["respondedAt", "grantId", "runId", "outcome"] as const) {
      if (proposal[field] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `pending 提案不能包含 ${field}`,
          path: [field],
        });
      }
    }
  }
  if (proposal.status === "rejected" && (!proposal.respondedAt || proposal.grantId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "rejected 提案必须有 respondedAt 且不能有 grantId",
    });
  }
  if (["approved", "executing", "waiting_permission", "waiting_plan_handoff", "completed", "failed"]
      .includes(proposal.status) && (!proposal.respondedAt || !proposal.grantId || !proposal.agentSessionId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "已批准提案必须绑定响应时间、一次性授权和 Agent 会话",
    });
  }
  if (["waiting_permission", "waiting_plan_handoff", "completed", "failed"].includes(proposal.status)
      && (!proposal.runId || !proposal.outcome)) {
    if (proposal.status === "failed" && proposal.outcome && !proposal.runId) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Agent 终态或等待态必须绑定结构化结果；已启动的执行还必须绑定 Run",
    });
  }
});
export type AgentProposal = z.infer<typeof AgentProposalSchema>;

export const AgentGrantSchema = z.object({
  schemaVersion: z.literal(AGENT_HANDOFF_SCHEMA_VERSION),
  id: identifier,
  proposalId: identifier,
  allowedCapabilities: AgentCapabilityListSchema,
  allowedPermissions: z.array(z.enum(TOOL_PERMISSION_VALUES)).min(1).max(5).superRefine((items, ctx) => {
    if (new Set(items).size !== items.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "权限不能重复" });
    }
  }),
  allowedScope: uniqueScopes,
  workspaceKey: identifier,
  expiresAfterRun: z.literal(true),
  status: AgentGrantStatusSchema,
  createdAt: timestamp,
  consumedAt: timestamp.optional(),
}).strict().superRefine((grant, ctx) => {
  if (grant.status === "active" && grant.consumedAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "active 授权不能已有 consumedAt" });
  }
  if (grant.status === "consumed" && !grant.consumedAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "consumed 授权必须记录 consumedAt" });
  }
  const expectedPermissions = capabilitiesToToolPermissions(grant.allowedCapabilities);
  if (
    expectedPermissions.length !== grant.allowedPermissions.length
    || expectedPermissions.some((permission) => !grant.allowedPermissions.includes(permission))
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "授权权限必须由允许能力唯一派生",
      path: ["allowedPermissions"],
    });
  }
});
export type AgentGrant = z.infer<typeof AgentGrantSchema>;

export const AgentSessionReadGrantStatusSchema = z.enum(["active", "revoked"]);
export const AgentSessionReadGrantSchema = z.object({
  schemaVersion: z.literal(AGENT_HANDOFF_SCHEMA_VERSION),
  id: identifier,
  companionSessionId: identifier,
  workspaceKey: identifier,
  allowedCapabilities: z.tuple([z.literal("file-read")]),
  allowedPermissions: z.tuple([z.literal("read")]),
  allowedScope: uniqueScopes,
  expiresAfterSession: z.literal(true),
  status: AgentSessionReadGrantStatusSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
  revokedAt: timestamp.optional(),
}).strict().superRefine((grant, ctx) => {
  if (grant.status === "active" && grant.revokedAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "active 会话只读授权不能已有 revokedAt" });
  }
  if (grant.status === "revoked" && !grant.revokedAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "revoked 会话只读授权必须记录 revokedAt" });
  }
});
export type AgentSessionReadGrant = z.infer<typeof AgentSessionReadGrantSchema>;

export const AgentProposalDecisionSchema = z.enum([
  "approve_once",
  "allow_session_read_only",
  "reject",
]);
export const AgentProposalRespondInputSchema = z.object({
  decision: AgentProposalDecisionSchema,
  allowedCapabilities: AgentCapabilityListSchema.optional(),
  workspaceKey: identifier.optional(),
}).strict().superRefine((input, ctx) => {
  if (input.decision === "reject" && (input.allowedCapabilities || input.workspaceKey)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "拒绝提案时不能附带授权能力或作用域",
    });
  }
  if (input.decision === "allow_session_read_only" && input.allowedCapabilities) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "会话只读授权能力由后端固定为 file-read，客户端不能覆盖",
      path: ["allowedCapabilities"],
    });
  }
});
export type AgentProposalRespondInput = z.infer<typeof AgentProposalRespondInputSchema>;

export const AgentProposalListFilterSchema = z.object({
  companionSessionId: identifier.optional(),
}).strict();
export type AgentProposalListFilter = z.infer<typeof AgentProposalListFilterSchema>;

export const AgentHandoffExecutionSchema = z.object({
  runId: identifier,
  outcome: AgentExecutionOutcomeSchema,
}).strict();

const AgentProposalResponseBaseSchema = z.object({
  proposal: AgentProposalSchema,
  grant: AgentGrantSchema.optional(),
  sessionReadGrant: AgentSessionReadGrantSchema.optional(),
  execution: AgentHandoffExecutionSchema.optional(),
}).strict();
export const AgentProposalResponseShape = AgentProposalResponseBaseSchema.shape;
export const AgentProposalResponseSchema = AgentProposalResponseBaseSchema.superRefine(
  addAgentProposalResponseIssues,
);
export type AgentProposalResponse = z.infer<typeof AgentProposalResponseBaseSchema>;

export function addAgentProposalResponseIssues(
  response: AgentProposalResponse,
  ctx: z.RefinementCtx,
): void {
  const sessionGrant = response.sessionReadGrant;
  if (!sessionGrant) return;
  const proposal = response.proposal;
  if (
    proposal.companionSessionId !== sessionGrant.companionSessionId
    || proposal.workspaceKey !== sessionGrant.workspaceKey
    || !sameStringSet(proposal.requestedScope, sessionGrant.allowedScope)
    || proposal.risk !== "read-only"
    || proposal.requestedCapabilities.length !== 1
    || proposal.requestedCapabilities[0] !== "file-read"
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "会话只读授权必须精确绑定当前只读提案的会话、工作区和作用域",
      path: ["sessionReadGrant"],
    });
  }
}

export function capabilitiesToToolPermissions(
  capabilities: readonly AgentCapability[],
): ToolPermission[] {
  const permissions = new Set<ToolPermission>(["read"]);
  for (const capability of capabilities) {
    if (capability === "file-write") permissions.add("write");
    if (capability === "shell") permissions.add("shell");
    if (capability === "browser") permissions.add("network");
    // dangerous is only a requestable ceiling: PermissionGuard still requires an
    // exact, second confirmation before the selected tool call can execute.
    if (capability === "file-write" || capability === "shell") permissions.add("dangerous");
  }
  return [...permissions];
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

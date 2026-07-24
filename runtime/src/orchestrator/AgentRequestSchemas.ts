import { z } from "zod";

import { MODEL_TASK_TYPES } from "../model/taskType.js";

const string = z.string();
const nonEmptyString = z.string().trim().min(1);
const boolean = z.boolean();
const integer = z.number().int();
const stringArray = z.array(string);

export const agentRunBudgetBodySchema = z
  .object({
    maxModelTurns: integer.nonnegative().optional(),
    maxToolCalls: integer.nonnegative().optional(),
    maxReadCalls: integer.nonnegative().optional(),
    maxWriteCalls: integer.nonnegative().optional(),
    maxShellCalls: integer.nonnegative().optional(),
    maxRuntimeMs: integer.nonnegative().optional(),
    maxPreflightTools: integer.nonnegative().optional(),
    maxRecoveryTurns: integer.nonnegative().optional(),
    maxRepeatedToolFailures: integer.nonnegative().optional(),
  })
  .strict();

export const agentPermissionPolicyBodySchema = z.enum([
  "readOnly",
  "confirmBeforeEdit",
  "autoEdit",
  "confirmBeforeRun",
  "autoRun",
]);

const agentConversationShape = {
  clientName: string.optional(),
  message: nonEmptyString,
  system: string.optional(),
  autoConfirm: boolean.optional(),
  sensitive: boolean.optional(),
  taskType: z.enum(MODEL_TASK_TYPES).optional(),
  mode: z.enum(["chat", "plan", "implement", "debug", "review"]).optional(),
  forceMode: boolean.optional(),
  permissionPolicy: agentPermissionPolicyBodySchema.optional(),
  budget: agentRunBudgetBodySchema.optional(),
  sessionId: string.optional(),
  projectId: string.optional(),
  workspaceKey: string.optional(),
  persist: boolean.optional(),
  skipPlanHandoff: boolean.optional(),
  streamTokens: boolean.optional(),
};

/** Internal Agent request and the only request accepted by the SSE endpoint. */
export const agentConversationRequestBodySchema = z.object(agentConversationShape).strict();

const planActivationShape = {
  activatePlan: boolean.optional(),
  userVisiblePlanId: string.optional(),
  dryRun: boolean.optional(),
  autoApprove: boolean.optional(),
  executionMode: z.enum(["static", "agent_loop"]).optional(),
  confirmedTodoIds: stringArray.optional(),
  approvedBy: string.optional(),
  rollbackOnFailure: boolean.optional(),
  fallbackToPlanOnUncertainty: boolean.optional(),
};

/** Message requests may carry an explicit plan id or activation flag for the outer Agent router. */
export const agentHttpMessageRequestBodySchema = z
  .object({ ...agentConversationShape, ...planActivationShape })
  .strict();

/** Explicit activation can omit a message, but must identify a plan or a session with a latest plan. */
export const agentUserVisiblePlanActivationRequestBodySchema = z
  .object({
    clientName: string.optional(),
    activatePlan: z.literal(true),
    userVisiblePlanId: string.optional(),
    sessionId: string.optional(),
    confirmedTodoIds: stringArray.optional(),
    dryRun: boolean.optional(),
    autoApprove: boolean.optional(),
    autoConfirm: boolean.optional(),
    permissionPolicy: agentPermissionPolicyBodySchema.optional(),
    executionMode: z.enum(["static", "agent_loop"]).optional(),
    approvedBy: string.optional(),
    rollbackOnFailure: boolean.optional(),
    fallbackToPlanOnUncertainty: boolean.optional(),
  })
  .strict()
  .refine(
    (value) => Boolean(value.userVisiblePlanId?.trim() || value.sessionId?.trim()),
    { message: "显式计划激活必须提供 userVisiblePlanId 或 sessionId" },
  );

/** An approved stored plan is executable only through the unified Agent entry. */
export const agentStoredPlanExecutionRequestBodySchema = z
  .object({
    clientName: string.optional(),
    activatePlan: z.literal(true),
    planId: nonEmptyString,
    version: integer.positive(),
    sessionId: string.optional(),
    dryRun: boolean.optional(),
    autoConfirm: boolean.optional(),
    permissionPolicy: agentPermissionPolicyBodySchema.optional(),
    executionMode: z.enum(["static", "agent_loop"]).optional(),
    rollbackOnFailure: boolean.optional(),
    fallbackToPlanOnUncertainty: boolean.optional(),
  })
  .strict();

export const agentPlanActivationRequestBodySchema = z.union([
  agentUserVisiblePlanActivationRequestBodySchema,
  agentStoredPlanExecutionRequestBodySchema,
]);

export const agentHttpRequestBodySchema = z.unknown().transform((value, ctx) => {
  const record = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
  const schema = record?.activatePlan === true && !("message" in record)
    ? agentPlanActivationRequestBodySchema
    : agentHttpMessageRequestBodySchema;
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  for (const issue of parsed.error.issues) ctx.addIssue(issue);
  return z.NEVER;
});

export type AgentConversationRequest = z.infer<typeof agentConversationRequestBodySchema>;
export type AgentHttpMessageRequest = z.infer<typeof agentHttpMessageRequestBodySchema>;
export type AgentPlanActivationRequest = z.infer<typeof agentPlanActivationRequestBodySchema>;
export type AgentStoredPlanExecutionRequest = z.infer<
  typeof agentStoredPlanExecutionRequestBodySchema
>;
export type AgentHttpRequest = z.infer<typeof agentHttpRequestBodySchema>;

export function isAgentPlanActivationRequest(
  request: AgentHttpRequest,
): request is AgentPlanActivationRequest {
  return !("message" in request);
}

export function isAgentStoredPlanExecutionRequest(
  request: AgentHttpRequest,
): request is AgentStoredPlanExecutionRequest {
  return !("message" in request) && "planId" in request;
}

export function toAgentConversationRequest(
  request: AgentHttpMessageRequest,
): AgentConversationRequest {
  const {
    activatePlan: _activatePlan,
    userVisiblePlanId: _userVisiblePlanId,
    dryRun: _dryRun,
    autoApprove: _autoApprove,
    executionMode: _executionMode,
    confirmedTodoIds: _confirmedTodoIds,
    approvedBy: _approvedBy,
    rollbackOnFailure: _rollbackOnFailure,
    fallbackToPlanOnUncertainty: _fallbackToPlanOnUncertainty,
    ...conversation
  } = request;
  return conversation;
}

export function formatAgentRequestValidationError(error: z.ZodError): string {
  const first = error.issues[0];
  const issue = first?.code === "invalid_union"
    ? first.unionErrors
        .flatMap((branch) => branch.issues)
        .find((candidate) => candidate.path.length > 0)
    : first;
  if (!issue) return "Agent 请求参数不合法";
  const field = issue.path.join(".") || "body";
  return `${field}: ${issue.message}`;
}

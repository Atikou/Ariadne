import { z } from 'zod';
import {
  isoDateTimeSchema,
  jsonValueSchema,
  nonEmptyIdSchema,
  resourceReferenceSchema
} from './common.js';

export const runtimeAvailabilitySchema = z.enum([
  'stopped',
  'starting',
  'ready',
  'degraded',
  'restarting',
  'crashed',
  'disabled'
]);

export const runtimeCapabilitySchema = z.enum([
  'companion.chat',
  'companion.sessions',
  'agent.proposals',
  'agent.runs',
  'agent.permissions',
  'agent.plans',
  'agent.tools',
  'agent.subagents',
  'models.local',
  'models.remote',
  'workspace.read',
  'workspace.write',
  'trace.read',
  'background.tasks',
  'scheduler'
]);

export const runtimeStatusSchema = z
  .object({
    availability: runtimeAvailabilitySchema,
    runtimeVersion: z.string().trim().min(1).max(64).optional(),
    protocolVersion: z.string().trim().min(1).max(32).optional(),
    capabilities: z.array(runtimeCapabilitySchema),
    detail: z.string().max(1_024).optional(),
    observedAt: isoDateTimeSchema
  })
  .strict();
export type RuntimeStatus = z.infer<typeof runtimeStatusSchema>;

export const reasoningModeSchema = z.enum(['off', 'on', 'auto', 'pro']);
export const reasoningEffortSchema = z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']);

export const modelReasoningProfileSchema = z.object({
  modes: z.array(reasoningModeSchema).min(1).max(4),
  defaultMode: reasoningModeSchema,
  efforts: z.array(reasoningEffortSchema).max(6),
  defaultEffort: reasoningEffortSchema.optional()
}).strict().superRefine((profile, context) => {
  if (new Set(profile.modes).size !== profile.modes.length) {
    context.addIssue({ code: 'custom', message: '可用推理模式不能重复。', path: ['modes'] });
  }
  if (new Set(profile.efforts).size !== profile.efforts.length) {
    context.addIssue({ code: 'custom', message: '可用推理强度不能重复。', path: ['efforts'] });
  }
  if (!profile.modes.includes(profile.defaultMode)) {
    context.addIssue({ code: 'custom', message: '默认推理模式必须在可用模式中。', path: ['defaultMode'] });
  }
  if (profile.defaultEffort && !profile.efforts.includes(profile.defaultEffort)) {
    context.addIssue({ code: 'custom', message: '默认推理强度必须在可用强度中。', path: ['defaultEffort'] });
  }
  if (profile.efforts.length > 0 && !profile.defaultEffort) {
    context.addIssue({ code: 'custom', message: '存在推理强度选项时必须设置默认值。', path: ['defaultEffort'] });
  }
});

export const modelInferenceProfileSchema = z.object({
  reasoning: modelReasoningProfileSchema.optional()
}).strict();
export type ModelInferenceProfile = z.infer<typeof modelInferenceProfileSchema>;

export const modelInferenceOptionsSchema = z.object({
  reasoningMode: reasoningModeSchema.optional(),
  reasoningEffort: reasoningEffortSchema.optional()
}).strict();
export type ModelInferenceOptions = z.infer<typeof modelInferenceOptionsSchema>;

export const chatRoutingStrategySchema = z.enum([
  'local-first',
  'cloud-first',
  'privacy-first',
  'quality-first'
]);
export type ChatRoutingStrategy = z.infer<typeof chatRoutingStrategySchema>;

export const workspaceAccessModeSchema = z.enum(['read', 'write']);
export type WorkspaceAccessMode = z.infer<typeof workspaceAccessModeSchema>;

export const modelSummarySchema = z
  .object({
    id: nonEmptyIdSchema,
    label: z.string().trim().min(1).max(256),
    location: z.enum(['local', 'remote']),
    availability: z.enum(['ready', 'unavailable', 'checking', 'error']),
    supportsAgent: z.boolean(),
    supportsVision: z.boolean(),
    inference: modelInferenceProfileSchema.optional(),
    detail: z.string().max(1_024).optional()
  })
  .strict();
export type ModelSummary = z.infer<typeof modelSummarySchema>;

export const conversationSessionSchema = z
  .object({
    sessionId: nonEmptyIdSchema,
    workspaceId: nonEmptyIdSchema,
    title: z.string().trim().min(1).max(512),
    pinned: z.boolean(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema
  })
  .strict();
export type ConversationSession = z.infer<typeof conversationSessionSchema>;

export const companionMessageErrorSchema = z
  .object({
    code: z.string().trim().min(1).max(128),
    message: z.string().trim().min(1).max(2_048),
    retryable: z.boolean().optional()
  })
  .strict();
export type CompanionMessageError = z.infer<typeof companionMessageErrorSchema>;

export const companionMessageSchema = z
  .object({
    messageId: nonEmptyIdSchema,
    sessionId: nonEmptyIdSchema,
    role: z.enum(['user', 'assistant', 'system']),
    content: z.string().max(2_000_000),
    status: z.enum(['streaming', 'completed', 'interrupted', 'failed']),
    createdAt: isoDateTimeSchema,
    agentProposalId: nonEmptyIdSchema.optional(),
    error: companionMessageErrorSchema.optional()
  })
  .strict();
export type CompanionMessage = z.infer<typeof companionMessageSchema>;

export const agentCapabilitySchema = z.enum(['file-read', 'file-write', 'browser', 'shell']);
export type AgentCapability = z.infer<typeof agentCapabilitySchema>;

export const agentProposalSchema = z
  .object({
    proposalId: nonEmptyIdSchema,
    sessionId: nonEmptyIdSchema,
    title: z.string().trim().min(1).max(512),
    reason: z.string().trim().min(1).max(4_096),
    originalRequest: z.string().trim().min(1).max(200_000),
    workspaceIds: z.array(nonEmptyIdSchema).max(32),
    requestedScopes: z.array(z.string().trim().min(1).max(1_024)).min(1).max(16),
    requestedCapabilities: z.array(agentCapabilitySchema).min(1).max(4),
    risk: z.enum(['read-only', 'write', 'destructive']),
    status: z.enum([
      'pending',
      'approved',
      'rejected',
      'executing',
      'waiting_permission',
      'waiting_plan_handoff',
      'completed',
      'failed'
    ]),
    createdAt: isoDateTimeSchema
  })
  .strict();
export type AgentProposal = z.infer<typeof agentProposalSchema>;

export const runStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_permission',
  'waiting_plan_handoff',
  'completed',
  'failed',
  'cancelled',
  'interrupted'
]);

export const runSummarySchema = z
  .object({
    runId: nonEmptyIdSchema,
    sessionId: nonEmptyIdSchema.optional(),
    origin: z.enum(['companion', 'agent']),
    title: z.string().trim().min(1).max(512),
    status: runStatusSchema,
    progress: z.number().min(0).max(1).optional(),
    userFacingLabel: z.string().trim().min(1).max(512),
    detail: z.string().trim().min(1).max(500).optional(),
    startedAt: isoDateTimeSchema.optional(),
    completedAt: isoDateTimeSchema.optional()
  })
  .strict();
export type RunSummary = z.infer<typeof runSummarySchema>;

export const runActivitySchema = z
  .object({
    activityId: nonEmptyIdSchema,
    runId: nonEmptyIdSchema,
    kind: z.enum(['model', 'tool', 'plan', 'subagent', 'status', 'warning', 'error']),
    status: z.enum(['pending', 'running', 'completed', 'failed', 'skipped']),
    title: z.string().trim().min(1).max(512),
    summary: z.string().max(8_192).optional(),
    occurredAt: isoDateTimeSchema
  })
  .strict();
export type RunActivity = z.infer<typeof runActivitySchema>;

export const permissionRequestSchema = z
  .object({
    requestId: nonEmptyIdSchema,
    runId: nonEmptyIdSchema,
    workspaceId: nonEmptyIdSchema.optional(),
    workspaceLabel: z.string().trim().min(1).max(512).optional(),
    approvalVersion: nonEmptyIdSchema,
    title: z.string().trim().min(1).max(512),
    reason: z.string().trim().min(1).max(8_192),
    permissionItems: z
      .array(
        z
          .object({
            itemId: nonEmptyIdSchema,
            capability: z.string().trim().min(1).max(128),
            targetLabel: z.string().trim().min(1).max(1_024),
            reason: z.string().trim().min(1).max(8_192),
            risk: z.enum(['low', 'medium', 'high', 'critical']),
            approvalScopes: z.array(z.enum(['once', 'session', 'project', 'workspace'])).min(1).max(4)
          })
          .strict()
      )
      .min(1)
      .max(128),
    status: z.enum(['pending', 'approved', 'rejected']),
    createdAt: isoDateTimeSchema
  })
  .strict();
export type PermissionRequest = z.infer<typeof permissionRequestSchema>;

export const planHandoffSchema = z
  .object({
    handoffId: nonEmptyIdSchema,
    runId: nonEmptyIdSchema,
    title: z.string().trim().min(1).max(512),
    summary: z.string().trim().min(1).max(100_000),
    steps: z
      .array(
        z
          .object({
            stepId: nonEmptyIdSchema,
            title: z.string().trim().min(1).max(512),
            detail: z.string().max(8_192).optional()
          })
          .strict()
      )
      .min(1)
      .max(512),
    status: z.enum(['pending', 'approved', 'rejected']),
    createdAt: isoDateTimeSchema
  })
  .strict();
export type PlanHandoff = z.infer<typeof planHandoffSchema>;

export const traceEntrySchema = z
  .object({
    traceId: nonEmptyIdSchema,
    runId: nonEmptyIdSchema.optional(),
    level: z.enum(['debug', 'info', 'warning', 'error']),
    category: z.string().trim().min(1).max(128),
    message: z.string().max(16_384),
    occurredAt: isoDateTimeSchema,
    metadata: z.record(z.string(), jsonValueSchema).optional()
  })
  .strict();
export type TraceEntry = z.infer<typeof traceEntrySchema>;

const emptyCommand = <T extends string>(kind: T) => z.object({ kind: z.literal(kind) }).strict();

export const runtimeCommandSchema = z.discriminatedUnion('kind', [
  emptyCommand('runtime.status.get'),
  emptyCommand('models.list'),
  z.object({ kind: z.literal('models.check'), modelId: nonEmptyIdSchema.optional() }).strict(),
  emptyCommand('companion.sessions.list'),
  z.object({
    kind: z.literal('companion.sessions.create'),
    workspaceId: nonEmptyIdSchema.optional(),
    title: z.string().trim().min(1).max(512).optional()
  }).strict(),
  z.object({ kind: z.literal('companion.sessions.rename'), sessionId: nonEmptyIdSchema, title: z.string().trim().min(1).max(512) }).strict(),
  z.object({ kind: z.literal('companion.sessions.delete'), sessionId: nonEmptyIdSchema }).strict(),
  z.object({ kind: z.literal('companion.messages.list'), sessionId: nonEmptyIdSchema, limit: z.number().int().min(1).max(1_000).default(200) }).strict(),
  z.object({
    kind: z.literal('companion.chat.start'),
    clientMessageId: nonEmptyIdSchema,
    sessionId: nonEmptyIdSchema.optional(),
    workspaceId: nonEmptyIdSchema.optional(),
    message: z.string().min(1).max(32_000).refine(
      (value) => value.trim().length > 0,
      '消息不能只包含空白字符。'
    ),
    modelId: nonEmptyIdSchema.optional(),
    inference: modelInferenceOptionsSchema.optional(),
    routingStrategy: chatRoutingStrategySchema.optional(),
    resources: z.array(resourceReferenceSchema).max(16).default([])
  }).strict(),
  z.object({ kind: z.literal('companion.chat.cancel'), runId: nonEmptyIdSchema }).strict(),
  emptyCommand('agent.proposals.list'),
  z.object({
    kind: z.literal('agent.proposals.respond'),
    proposalId: nonEmptyIdSchema,
    decision: z.enum(['approve_once', 'allow_session_read_only', 'reject']),
    allowedCapabilities: z.array(agentCapabilitySchema).min(1).max(4).optional(),
    workspaceId: nonEmptyIdSchema.optional(),
    workspaceAccess: workspaceAccessModeSchema.optional()
  }).strict().superRefine((input, context) => {
    if (input.decision === 'reject' && (input.allowedCapabilities || input.workspaceId || input.workspaceAccess)) {
      context.addIssue({ code: 'custom', message: '拒绝提案时不能附带授权能力或工作区。' });
    }
    if (input.decision === 'allow_session_read_only' && input.allowedCapabilities) {
      context.addIssue({ code: 'custom', message: '会话只读授权固定为 file-read。', path: ['allowedCapabilities'] });
    }
  }),
  z.object({ kind: z.literal('runs.list'), sessionId: nonEmptyIdSchema.optional(), status: runStatusSchema.optional() }).strict(),
  z.object({ kind: z.literal('runs.get'), runId: nonEmptyIdSchema }).strict(),
  z.object({ kind: z.literal('runs.cancel'), runId: nonEmptyIdSchema }).strict(),
  emptyCommand('permissions.list'),
  z.object({
    kind: z.literal('permissions.respond'),
    requestId: nonEmptyIdSchema,
    approvalVersion: nonEmptyIdSchema,
    decision: z.enum(['allow_once', 'allow_session', 'allow_project', 'allow_workspace', 'deny']),
    approvedItemIds: z.array(nonEmptyIdSchema).max(128)
  }).strict(),
  z.object({ kind: z.literal('permissions.resume'), requestId: nonEmptyIdSchema }).strict(),
  emptyCommand('planHandoffs.list'),
  z.object({ kind: z.literal('planHandoffs.respond'), handoffId: nonEmptyIdSchema, decision: z.enum(['approve', 'reject']) }).strict(),
  z.object({ kind: z.literal('planHandoffs.resume'), handoffId: nonEmptyIdSchema }).strict(),
  z.object({ kind: z.literal('trace.list'), runId: nonEmptyIdSchema.optional(), limit: z.number().int().min(1).max(2_000).default(200) }).strict()
]);

export type RuntimeCommand = z.infer<typeof runtimeCommandSchema>;

export const runtimeResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('runtime.status'), status: runtimeStatusSchema }).strict(),
  z.object({ kind: z.literal('models.catalog'), models: z.array(modelSummarySchema) }).strict(),
  z.object({ kind: z.literal('companion.sessions'), sessions: z.array(conversationSessionSchema) }).strict(),
  z.object({ kind: z.literal('companion.session'), session: conversationSessionSchema }).strict(),
  z.object({ kind: z.literal('companion.messages'), messages: z.array(companionMessageSchema) }).strict(),
  z.object({ kind: z.literal('companion.chat.accepted'), runId: nonEmptyIdSchema, sessionId: nonEmptyIdSchema }).strict(),
  z.object({ kind: z.literal('agent.proposals'), proposals: z.array(agentProposalSchema) }).strict(),
  z.object({ kind: z.literal('agent.proposal'), proposal: agentProposalSchema }).strict(),
  z.object({ kind: z.literal('runs'), runs: z.array(runSummarySchema) }).strict(),
  z.object({ kind: z.literal('run'), run: runSummarySchema }).strict(),
  z.object({ kind: z.literal('permissions'), requests: z.array(permissionRequestSchema) }).strict(),
  z.object({ kind: z.literal('permission'), request: permissionRequestSchema }).strict(),
  z.object({ kind: z.literal('planHandoffs'), handoffs: z.array(planHandoffSchema) }).strict(),
  z.object({ kind: z.literal('planHandoff'), handoff: planHandoffSchema }).strict(),
  z.object({ kind: z.literal('trace'), entries: z.array(traceEntrySchema) }).strict(),
  z.object({ kind: z.literal('acknowledged') }).strict()
]);

export type RuntimeResult = z.infer<typeof runtimeResultSchema>;

export const runtimeEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('runtime.status.changed'), status: runtimeStatusSchema }).strict(),
  z.object({ kind: z.literal('companion.token.delta'), runId: nonEmptyIdSchema, sessionId: nonEmptyIdSchema, messageId: nonEmptyIdSchema, text: z.string().min(1).max(64_000) }).strict(),
  z.object({ kind: z.literal('companion.message.changed'), message: companionMessageSchema }).strict(),
  z.object({ kind: z.literal('agent.proposal.changed'), proposal: agentProposalSchema }).strict(),
  z.object({ kind: z.literal('run.changed'), run: runSummarySchema }).strict(),
  z.object({ kind: z.literal('run.activity'), activity: runActivitySchema }).strict(),
  z.object({ kind: z.literal('permission.changed'), request: permissionRequestSchema }).strict(),
  z.object({ kind: z.literal('planHandoff.changed'), handoff: planHandoffSchema }).strict(),
  z.object({ kind: z.literal('trace.appended'), entry: traceEntrySchema }).strict()
]);

export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;

export const publicRuntimeApiSchema = z
  .object({
    command: runtimeCommandSchema,
    requestId: nonEmptyIdSchema
  })
  .strict();

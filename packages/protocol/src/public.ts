import { z } from 'zod';
import {
  isoDateTimeSchema,
  jsonValueSchema,
  nonEmptyIdSchema,
  resourceReferenceSchema
} from './common.js';
import {
  PUBLIC_DECISION_ACTION_CONTRACT_VERSION,
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  publicDecisionActionTokenSchema,
  publicDecisionChoiceSchema,
  publicProjectionCanonicalIdSchema,
  publicProjectionFeatureSchema,
  publicProjectionReadBatchSchema,
  publicProjectionReadRequestSchema,
  publicProjectionSnapshotSchema
} from './public/projection.js';
import { encodedImageAttachmentsSchema } from './public/attachments.js';
import { publicInferenceStreamEventSchema } from './public/inference-stream.js';
import { publicProjectionSnapshotBeginRequestSchema, publicProjectionSnapshotManifestSchema,
  publicProjectionSnapshotPageRequestSchema, publicProjectionSnapshotPageResetSchema,
  publicProjectionSnapshotPageResultSchema } from './public/projection-pages.js';
import { publicProjectionScopedReadRequestSchema, publicProjectionScopedReadBatchSchema } from './public/projection-scoped-read.js';
import { publicProjectionViewBeginRequestSchema, publicProjectionViewManifestSchema,
  publicProjectionViewPageRequestSchema, publicProjectionViewPageResultSchema,
  publicProjectionMessageWindowRequestSchema, publicProjectionMessageWindowResultSchema } from './public/projection-views.js';
import { productivityCommandSchemas, productivityResultSchemas } from './public/productivity.js';
import { productivityTaskIsolationCommandSchemas, productivityTaskIsolationResultSchemas } from './public/productivity-task-isolation.js';
export * from './public/productivity-task-isolation.js';
import { publicProjectionCatalogBeginRequestSchema, publicProjectionCatalogManifestSchema, publicProjectionCatalogResetSchema,
  publicProjectionCatalogPageRequestSchema, publicProjectionCatalogPageResultSchema,
  publicProjectionCatalogDetailRequestSchema, publicProjectionCatalogDetailResultSchema,
  publicProjectionCatalogReadRequestSchema, publicProjectionCatalogBatchResultSchema } from './public/projection-catalog.js';
import { publicProjectionFeatureWindowRequestSchema, publicProjectionFeatureWindowResultSchema } from './public/projection-feature-window.js';
import { publicProjectionFeatureReceiptRequestSchema, publicProjectionFeatureReceiptResultSchema } from './public/projection-feature-receipts.js';
import { publicRunDocumentRootRequestSchema, publicRunDocumentRootResultSchema,
  publicRunDocumentMetadataRequestSchema, publicRunDocumentMetadataResultSchema,
  publicRunDocumentInboxRequestSchema, publicRunDocumentInboxResultSchema,
  publicRunDocumentChunkRequestSchema, publicRunDocumentChunkResultSchema } from './public/projection-run-document-query.js';
import { publicMessageMetadataWindowRequestSchema, publicMessageMetadataWindowResultSchema,
  publicMessageBodyRequestSchema, publicMessageBodyResultSchema } from './public/projection-message-metadata.js';
import { publicConversationReceiptRequestSchema, publicConversationReceiptResultSchema,
  publicConversationInferenceRequestSchema, publicConversationInferenceResultSchema } from './public/projection-conversation.js';
import { longMemoryCommandSchemas, longMemoryResultSchemas } from './public/long-memory.js';
import { modelQualityResultSchema, modelQualitySummarySchema } from './public/stored-model-quality.js';
import { workspaceDocumentCommandSchemas,workspaceDocumentResultSchemas } from './public/workspace-documents.js';
import { runtimeHealthSchema } from './public/runtime-health.js';
import { createTaskCenterNavigationResultSchema, taskCenterQuerySchema, taskCenterNavigationSchema,
  taskCenterPageSchema, taskCenterResetSchema, taskCenterRelationsQuerySchema, taskCenterRelationsResultSchema } from './public/task-center.js';
export * from './public/runtime-health.js';
export * from './public/projection.js';
export * from './public/projection-pages.js';
export * from './public/projection-scoped-read.js';
export * from './public/projection-views.js';
export * from './public/projection-catalog.js';
export * from './public/projection-feature-window.js';
export * from './public/projection-feature-receipts.js';
export * from './public/projection-conversation.js';
export * from './public/projection-run-document.js';
export * from './public/projection-run-document-commit.js';
export * from './public/projection-run-document-query.js';
export * from './public/projection-message-metadata.js';
export * from './public/inference-stream.js';
export * from './public/attachments.js';
export * from './public/decision-action.js';
export * from './public/productivity.js';
export * from './public/task-center.js';
export * from './public/long-memory.js';
export * from './public/stored-model-quality.js';
export * from './public/workspace-documents.js';
export type { JsonValue } from './common.js';
export { ARIADNE_RUNTIME_PROTOCOL_VERSION } from './common.js';

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
  'companion.agent-plan',
  'companion.sessions',
  'agent.proposals', // Historical status decoding only; production declaration is retired.
  'agent.runs',
  'agent.inbox',
  'agent.permissions',
  'agent.plans',
  'agent.tools',
  'agent.subagents',
  'models.local',
  'models.remote',
  'computer.read',
  'workspace.read',
  'workspace.write',
  'observability.diagnostics',
  'telemetry.export',
  'live.work',
  'scheduler',
  'productivity.workflow',
  'resources', // Historical status decoding only; attachment/Tool owners replace this public surface.
  'memory.manage',
  'mcp.tools',
  'skills.catalog',
  'hooks.lifecycle',
  'browser.web'
]);
export type RuntimeCapability = z.infer<typeof runtimeCapabilitySchema>;

export const runtimeStatusSchema = z
  .object({
    availability: runtimeAvailabilitySchema,
    runtimeVersion: z.string().trim().min(1).max(64).optional(),
    runtimeBuildFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
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

export const modelSelectionSchema = z.object({
  modelId: z.string().trim().max(256),
  localFallbackModelId: z.string().trim().max(256)
}).strict();
export type ModelSelection = z.infer<typeof modelSelectionSchema>;

export const workspaceAccessModeSchema = z.enum(['read', 'write']);
export type WorkspaceAccessMode = z.infer<typeof workspaceAccessModeSchema>;

export const modelSummarySchema = z
  .object({
    id: nonEmptyIdSchema,
    label: z.string().trim().min(1).max(256),
    location: z.enum(['local', 'remote']),
    enabled: z.boolean().optional(),
    availability: z.enum(['ready', 'unavailable', 'checking', 'error']),
    supportsTextChat: z.boolean(),
    supportsAgent: z.boolean(),
    supportsPlan: z.boolean(),
    supportsVision: z.boolean(),
    qualificationState: z.enum(['unknown', 'testing', 'qualified', 'rejected']),
    quality: modelQualitySummarySchema.optional(),
    providerQualification: z.object({
      nativeTools: z.enum(['supported', 'unsupported', 'unknown']),
      streaming: z.enum(['supported', 'unsupported', 'unknown']),
      reasoning: z.enum(['supported', 'unsupported', 'unknown']),
      cancellation: z.enum(['supported', 'unsupported', 'unknown']),
      tokenizer: z.enum(['exact', 'conservative', 'unknown']),
      errorBehavior: z.enum(['classified', 'unknown']),
      evidence: z.string().max(512).optional(),
      verifiedAt: isoDateTimeSchema.optional()
    }).strict().optional(),
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
    status: z.enum(['active', 'archived']),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema
  })
  .strict();
export type ConversationSession = z.infer<typeof conversationSessionSchema>;

export const conversationMessageReferenceSchema = z.object({
  sessionId: publicProjectionCanonicalIdSchema,
  messageId: publicProjectionCanonicalIdSchema,
  messageVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u)
}).strict();
export type ConversationMessageReference = z.infer<
  typeof conversationMessageReferenceSchema
>;
export const taskCenterNavigationResultSchema = createTaskCenterNavigationResultSchema(conversationMessageReferenceSchema)
  .superRefine((result, context) => {
    if (result.target?.resultReference && (result.target.moduleId !== 'chat.main'
      || result.target.resultReference.sessionId !== result.target.sessionId))
      context.addIssue({ code: 'custom', message: 'Task result reference escaped its navigation Session.' });
  });
export type TaskCenterNavigationResult = z.infer<typeof taskCenterNavigationResultSchema>;

export const companionMessageErrorSchema = z
  .object({
    code: z.string().trim().min(1).max(128),
    message: z.string().trim().min(1).max(2_048),
    retryable: z.boolean().optional()
  })
  .strict();

export const companionReasoningSegmentSchema = z
  .object({
    segmentId: nonEmptyIdSchema,
    kind: z.enum(['thought', 'intermediate_response']),
    content: z.string().trim().min(1).max(200_000),
    occurredAt: isoDateTimeSchema,
    iteration: z.number().int().nonnegative().optional()
  })
  .strict();
export type CompanionReasoningSegment = z.infer<typeof companionReasoningSegmentSchema>;

export const companionMessageReasoningSchema = z
  .object({
    content: z.string().max(2_000_000),
    status: z.enum(['streaming', 'completed', 'interrupted']),
    source: z.enum(['provider', 'summary']),
    startedAt: isoDateTimeSchema,
    completedAt: isoDateTimeSchema.optional(),
    durationMs: z.number().int().nonnegative().optional(),
    segments: z.array(companionReasoningSegmentSchema).max(2_000).optional()
  })
  .strict();
export type CompanionMessageReasoning = z.infer<typeof companionMessageReasoningSchema>;

export const companionMessageSchema = z
  .object({
    messageId: nonEmptyIdSchema,
    sessionId: nonEmptyIdSchema,
    runId: nonEmptyIdSchema.optional(),
    role: z.enum(['user', 'assistant', 'system']),
    content: z.string().max(2_000_000),
    status: z.enum(['streaming', 'completed', 'interrupted', 'failed']),
    createdAt: isoDateTimeSchema,
    processingDurationMs: z.number().int().nonnegative().optional(),
    reasoning: companionMessageReasoningSchema.optional(),
    agentProposalId: nonEmptyIdSchema.optional(),
    error: companionMessageErrorSchema.optional()
  })
  .strict();
export type CompanionMessage = z.infer<typeof companionMessageSchema>;

export const runStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_permission',
  'waiting_plan_handoff',
  'waiting_budget',
  'paused',
  'completed',
  'failed',
  'cancelled',
  'interrupted'
]);

export const runBudgetSchema = z
  .object({
    maxModelTurns: z.number().int().positive(),
    maxToolCalls: z.number().int().positive(),
    maxReadCalls: z.number().int().nonnegative(),
    maxWriteCalls: z.number().int().nonnegative(),
    maxShellCalls: z.number().int().nonnegative(),
    maxRuntimeMs: z.number().int().positive(),
    maxPreflightTools: z.number().int().nonnegative(),
    maxRecoveryTurns: z.number().int().nonnegative(),
    maxRepeatedToolFailures: z.number().int().nonnegative()
  })
  .strict();

export const runBudgetUsageSchema = z
  .object({
    modelTurns: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    attemptedToolCalls: z.number().int().nonnegative().optional(),
    readCalls: z.number().int().nonnegative(),
    writeCalls: z.number().int().nonnegative(),
    shellCalls: z.number().int().nonnegative(),
    runtimeMs: z.number().int().nonnegative(),
    mainModelTurns: z.number().int().nonnegative().optional(),
    preflightTools: z.number().int().nonnegative().optional(),
    recoveryTurns: z.number().int().nonnegative().optional(),
    cachedToolHits: z.number().int().nonnegative().optional(),
    toolFailures: z.number().int().nonnegative().optional(),
    toolObservationFailures: z.number().int().nonnegative().optional(),
    toolExecutionErrors: z.number().int().nonnegative().optional()
  })
  .strict();

export const runSummarySchema = z
  .object({
    runId: nonEmptyIdSchema,
    sessionId: nonEmptyIdSchema.optional(),
    sourceMessageId: nonEmptyIdSchema.optional(),
    origin: z.enum(['companion', 'agent']),
    title: z.string().trim().min(1).max(512),
    status: runStatusSchema,
    progress: z.number().min(0).max(1).optional(),
    userFacingLabel: z.string().trim().min(1).max(512),
    aggregateVersion: z.number().int().positive(),
    checkpointStage: z.string().trim().min(1).max(128),
    recoveryStatus: z.enum(['none', 'recoverable', 'decision_required']),
    budgetUsage: runBudgetUsageSchema.optional(),
    suggestedBudget: runBudgetSchema.optional(),
    budgetExhausted: z.string().trim().min(1).max(128).optional(),
    detail: z.string().trim().min(1).max(500).optional(),
    timing: z.object({
      activeDurationMs: z.number().int().nonnegative(),
      activeSince: isoDateTimeSchema.optional()
    }).strict(),
    startedAt: isoDateTimeSchema.optional(),
    completedAt: isoDateTimeSchema.optional()
  })
  .strict();
export type RunSummary = z.infer<typeof runSummarySchema>;

export const runActivityStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'skipped'
]);

export const runActivityNodeSchema = z
  .object({
    activityType: z.literal('tool'),
    activityId: nonEmptyIdSchema,
    runId: nonEmptyIdSchema,
    toolCallId: nonEmptyIdSchema,
    toolName: z.string().trim().min(1).max(256),
    presentationKind: z.enum([
      'generic',
      'file_read',
      'file_search',
      'file_change',
      'command',
      'terminal',
      'browser',
      'skill',
      'external'
    ]).optional(),
    status: runActivityStatusSchema,
    title: z.string().trim().min(1).max(512),
    summary: z.string().max(8_192).optional(),
    occurredAt: isoDateTimeSchema,
    startedAt: isoDateTimeSchema.optional(),
    completedAt: isoDateTimeSchema.optional(),
    durationMs: z.number().int().nonnegative().optional(),
    iteration: z.number().int().nonnegative(),
    batchId: nonEmptyIdSchema,
    laneId: nonEmptyIdSchema,
    parentActivityId: nonEmptyIdSchema.optional(),
    dependsOnActivityIds: z.array(nonEmptyIdSchema).max(512),
    detailAvailable: z.boolean(),
    changedFileCount: z.number().int().nonnegative()
  })
  .strict();

export const runSystemActivitySchema = z.object({
  activityType: z.literal('system'),
  activityId: nonEmptyIdSchema,
  runId: nonEmptyIdSchema,
  kind: z.enum(['context_compaction', 'working_context_compaction']),
  status: runActivityStatusSchema,
  title: z.string().trim().min(1).max(512),
  summary: z.string().max(8_192).optional(),
  occurredAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.optional(),
  completedAt: isoDateTimeSchema.optional(),
  durationMs: z.number().int().nonnegative().optional(),
  processedMessages: z.number().int().nonnegative().optional(),
  beforeChars: z.number().int().nonnegative().optional(),
  afterChars: z.number().int().nonnegative().optional(),
  summaryType: z.string().trim().min(1).max(128).optional()
}).strict();

export const runActivitySchema = z.discriminatedUnion('activityType', [
  runActivityNodeSchema,
  runSystemActivitySchema
]);
export type RunActivity = z.infer<typeof runActivitySchema>;

export const permissionRequestSchema = z
  .object({
    requestId: nonEmptyIdSchema,
    runId: nonEmptyIdSchema,
    sessionId: nonEmptyIdSchema.optional(),
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

export const agentPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    planId: nonEmptyIdSchema,
    version: z.number().int().positive(),
    sourceRunId: nonEmptyIdSchema,
    sessionId: nonEmptyIdSchema.optional(),
    supersedesVersion: z.number().int().positive().optional(),
    title: z.string().trim().min(1).max(512),
    goal: z.string().trim().min(1).max(100_000),
    facts: z.array(z.object({
      id: nonEmptyIdSchema,
      statement: z.string().trim().min(1).max(8_192),
      evidence: z.string().trim().min(1).max(8_192)
    }).strict()).min(1).max(64),
    constraints: z.array(z.object({
      id: nonEmptyIdSchema,
      kind: z.enum(['constraint', 'non_goal', 'assumption']),
      statement: z.string().trim().min(1).max(8_192)
    }).strict()).max(64),
    clarifications: z.array(z.object({
      id: nonEmptyIdSchema,
      question: z.string().trim().min(1).max(8_192),
      impact: z.string().trim().min(1).max(8_192)
    }).strict()).max(12),
    steps: z.array(z.object({
      id: nonEmptyIdSchema,
      title: z.string().trim().min(1).max(512),
      dependsOn: z.array(nonEmptyIdSchema).max(16),
      action: z.string().trim().min(1).max(8_192),
      scope: z.array(z.string().trim().min(1).max(4_096)).min(1).max(32),
      expectedOutcome: z.string().trim().min(1).max(8_192),
      verification: z.string().trim().min(1).max(8_192),
      status: z.enum(['pending', 'in_progress', 'blocked', 'completed', 'failed']),
      actualScope: z.array(z.string().max(4_096)).max(128),
      evidence: z.array(z.string().max(8_192)).max(128),
      deviations: z.array(z.string().max(8_192)).max(128),
      blockingReason: z.string().max(8_192).optional()
    }).strict()).max(7),
    completionCriteria: z.array(z.object({
      id: nonEmptyIdSchema,
      behavior: z.string().trim().min(1).max(8_192),
      verification: z.string().trim().min(1).max(8_192)
    }).strict()).max(32),
    planState: z.enum([
      'collecting_context',
      'needs_clarification',
      'ready_for_confirmation',
      'approved',
      'superseded'
    ]),
    executionState: z.enum(['not_started', 'in_progress', 'blocked', 'completed', 'failed']),
    completeness: z.enum(['incomplete', 'complete']),
    blockingReasons: z.array(z.string().max(8_192)).max(32),
    qualityIssues: z.array(z.object({
      code: z.enum([
        'invalid_schema',
        'missing_execution_steps',
        'critical_ambiguity_with_steps',
        'inconsistent_step_granularity',
        'invalid_step_dependency',
        'context_check_is_execution_step',
        'unfounded_limit',
        'optional_verification',
        'missing_completion_criteria',
        'vague_completion_criterion'
      ]),
      severity: z.enum(['warning', 'critical']),
      message: z.string().trim().min(1).max(8_192),
      path: z.string().max(1_024).optional()
    }).strict()).max(64),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema
  })
  .strict();
export type AgentPlan = z.infer<typeof agentPlanSchema>;

export const planHandoffSchema = z
  .object({
    handoffId: nonEmptyIdSchema,
    runId: nonEmptyIdSchema,
    sessionId: nonEmptyIdSchema.optional(),
    plan: agentPlanSchema,
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

export const runtimeEventSchema = z.discriminatedUnion('kind', [
  ...publicInferenceStreamEventSchema.options,
  z.object({ kind: z.literal('projection.changed'), feature: publicProjectionFeatureSchema }).strict()
]);
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;

export const runtimeEventEnvelopeSchema = z
  .object({
    eventId: nonEmptyIdSchema,
    cursor: z.number().int().positive(),
    schemaVersion: z.literal('2.0'),
    aggregateType: z.enum(['projection', 'inference_stream']),
    aggregateId: nonEmptyIdSchema,
    aggregateVersion: z.number().int().positive(),
    correlationId: nonEmptyIdSchema.optional(),
    causationId: nonEmptyIdSchema.optional(),
    occurredAt: isoDateTimeSchema,
    event: runtimeEventSchema
  })
  .strict();
export type RuntimeEventEnvelope = z.infer<typeof runtimeEventEnvelopeSchema>;

const emptyCommand = <T extends string>(kind: T) => z.object({ kind: z.literal(kind) }).strict();

export const publicDecisionResolutionActionSchema = z.object({
  contractVersion: z.literal(PUBLIC_DECISION_ACTION_CONTRACT_VERSION),
  actionToken: publicDecisionActionTokenSchema,
  choice: publicDecisionChoiceSchema,
  answer: z.string().min(1).max(100_000).refine(
    (value) => value.trim().length > 0,
    'A user-question answer cannot contain only whitespace.'
  ).optional()
}).strict().superRefine((value, context) => {
  if ((value.choice === 'answer') !== (value.answer !== undefined)) {
    context.addIssue({
      code: 'custom',
      path: ['answer'],
      message: 'Only the answer choice requires one bounded answer body.'
    });
  }
});

export const PERSONAL_ASSISTANT_WORKSPACE_ID = 'ariadne-personal-assistant' as const;
export const COMPUTER_READ_SCOPE_ID = 'computer-read-all' as const;

export const conversationMessageExecutionSchema = z.object({
  mode: z.enum(['chat', 'agent', 'plan']),
  modelId: publicProjectionCanonicalIdSchema.optional(),
  inference: modelInferenceOptionsSchema.optional(),
  localFallbackModelId: publicProjectionCanonicalIdSchema.nullable().optional()
}).strict();
export type ConversationMessageExecution = z.infer<
  typeof conversationMessageExecutionSchema
>;

const conversationMessageAcceptCommandSchema = z.object({
  kind: z.literal('conversation.message.accept'),
  contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
  sessionId: publicProjectionCanonicalIdSchema,
  workspaceId: publicProjectionCanonicalIdSchema,
  expectedSessionVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  messageId: publicProjectionCanonicalIdSchema,
  content: z.string().max(100_000),
  attachments: encodedImageAttachmentsSchema.optional(),
  execution: conversationMessageExecutionSchema.optional()
}).strict().superRefine((value, context) => {
  if (value.content.trim().length === 0 && value.attachments === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['content'],
      message: 'Conversation message requires text or an image attachment.'
    });
  }
});

export const runtimeCommandSchema = z.discriminatedUnion('kind', [
  taskCenterQuerySchema, taskCenterNavigationSchema,
  taskCenterRelationsQuerySchema,
  ...productivityCommandSchemas,
  ...productivityTaskIsolationCommandSchemas,
  ...longMemoryCommandSchemas,
  ...workspaceDocumentCommandSchemas,
  emptyCommand('runtime.status.get'),
  emptyCommand('runtime.health.get'),
  z.object({
    kind: z.literal('model.qualification.run'),
    contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    modelId: publicProjectionCanonicalIdSchema
  }).strict(),
  z.object({
    kind: z.literal('model.availability.check'),
    contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    modelId: publicProjectionCanonicalIdSchema
  }).strict(),
  z.object({
    kind: z.literal('projection.snapshot.get'),
    contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION)
  }).strict(),
  z.object({
    kind: z.literal('projection.commits.read'),
    request: publicProjectionReadRequestSchema
  }).strict(),
  z.object({
    kind: z.literal('conversation.session.create'),
    contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    sessionId: publicProjectionCanonicalIdSchema,
    workspaceId: publicProjectionCanonicalIdSchema,
    title: z.string().trim().min(1).max(80).optional()
  }).strict(),
  z.object({ kind: z.literal('projection.snapshot.begin'), request: publicProjectionSnapshotBeginRequestSchema }).strict(),
  z.object({ kind: z.literal('projection.snapshot.page'), request: publicProjectionSnapshotPageRequestSchema }).strict(),
  z.object({ kind: z.literal('projection.scope.read'), request: publicProjectionScopedReadRequestSchema }).strict(),
  z.object({ kind: z.literal('projection.view.begin'), request: publicProjectionViewBeginRequestSchema }).strict(),
  z.object({ kind: z.literal('projection.view.page'), request: publicProjectionViewPageRequestSchema }).strict(),
  z.object({ kind: z.literal('projection.messages.window'), request: publicProjectionMessageWindowRequestSchema }).strict(),
  z.object({ kind: z.literal('projection.catalog.begin'), request: publicProjectionCatalogBeginRequestSchema }).strict(),
  z.object({ kind: z.literal('projection.catalog.page'), request: publicProjectionCatalogPageRequestSchema }).strict(),
  z.object({ kind: z.literal('projection.catalog.detail'), request: publicProjectionCatalogDetailRequestSchema }).strict(),
  z.object({ kind: z.literal('projection.catalog.read'), request: publicProjectionCatalogReadRequestSchema }).strict(),
  z.object({ kind: z.literal('projection.features.window'), request: publicProjectionFeatureWindowRequestSchema }).strict(),
  z.object({ kind: z.literal('projection.features.receipts'), request: publicProjectionFeatureReceiptRequestSchema }).strict(),
  z.object({ kind: z.literal('projection.run_document.root'), request: publicRunDocumentRootRequestSchema }).strict(),
  z.object({ kind: z.literal('projection.run_document.metadata'), request: publicRunDocumentMetadataRequestSchema }).strict(),
  z.object({ kind: z.literal('projection.run_document.inbox'), request: publicRunDocumentInboxRequestSchema }).strict(),
  z.object({ kind: z.literal('projection.run_document.chunk'), request: publicRunDocumentChunkRequestSchema }).strict(),
  z.object({ kind: z.literal('projection.messages.metadata'), request: publicMessageMetadataWindowRequestSchema }).strict(),
  z.object({ kind: z.literal('projection.messages.body'), request: publicMessageBodyRequestSchema }).strict(),
  z.object({ kind: z.literal('projection.conversation.receipts'), request: publicConversationReceiptRequestSchema }).strict(),
  z.object({ kind: z.literal('projection.conversation.inference_window'), request: publicConversationInferenceRequestSchema }).strict(),
  z.object({
    kind: z.literal('conversation.session.title.generate'),
    contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    sessionId: publicProjectionCanonicalIdSchema,
    workspaceId: publicProjectionCanonicalIdSchema,
    expectedSessionVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    content: z.string().trim().min(1).max(100_000),
    execution: conversationMessageExecutionSchema.optional()
  }).strict(),
  z.object({
    kind: z.literal('conversation.session.rename'),
    contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    sessionId: publicProjectionCanonicalIdSchema,
    workspaceId: publicProjectionCanonicalIdSchema,
    expectedSessionVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    title: z.string().trim().min(1).max(80)
  }).strict(),
  z.object({
    kind: z.literal('conversation.session.archive'),
    contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    sessionId: publicProjectionCanonicalIdSchema,
    workspaceId: publicProjectionCanonicalIdSchema,
    expectedSessionVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  }).strict(),
  z.object({
    kind: z.literal('conversation.session.restore'),
    contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    sessionId: publicProjectionCanonicalIdSchema,
    workspaceId: publicProjectionCanonicalIdSchema,
    expectedSessionVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  }).strict(),
  z.object({
    kind: z.literal('conversation.session.fork'),
    contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    sessionId: publicProjectionCanonicalIdSchema,
    sourceSessionId: publicProjectionCanonicalIdSchema,
    workspaceId: publicProjectionCanonicalIdSchema,
    expectedSourceSessionVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    boundary: conversationMessageReferenceSchema,
    sourceVersionMode: z.enum(['current', 'frozen']).optional(),
    title: z.string().trim().min(1).max(80).optional()
  }).strict(),
  z.object({
    kind: z.literal('conversation.sessions.query'),
    contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    workspaceId: publicProjectionCanonicalIdSchema,
    query: z.string().trim().max(512),
    status: z.enum(['active', 'archived', 'all']).default('active'),
    limit: z.number().int().min(1).max(50).default(20)
  }).strict(),
  z.object({
    kind: z.literal('conversation.message.resolve'),
    contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    reference: conversationMessageReferenceSchema
  }).strict(),
  z.object({
    kind: z.literal('skill.commands.query'),
    contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    workspaceId: publicProjectionCanonicalIdSchema
  }).strict(),
  z.object({
    kind: z.literal('skill.command.load'),
    contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    workspaceId: publicProjectionCanonicalIdSchema,
    name: z.string().regex(/^[a-z][a-z0-9_-]*$/u),
    revision: z.string().regex(/^sha256:[a-f0-9]{64}$/u)
  }).strict(),
  z.object({
    kind: z.literal('skill.command.resource.read'),
    contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    workspaceId: publicProjectionCanonicalIdSchema,
    name: z.string().regex(/^[a-z][a-z0-9_-]*$/u),
    revision: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    relativePath: z.string().min(1).max(512)
  }).strict(),
  z.object({
    kind: z.literal('agent.tool_result.detail.get'),
    contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    runId: publicProjectionCanonicalIdSchema,
    workspaceId: publicProjectionCanonicalIdSchema,
    effectId: publicProjectionCanonicalIdSchema,
    cursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
    maxBytes: z.number().int().min(1).max(64 * 1024).default(64 * 1024)
  }).strict(),
  conversationMessageAcceptCommandSchema,
  z.object({
    kind: z.literal('agent.decision.resolve'),
    contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    runId: publicProjectionCanonicalIdSchema,
    decisionId: publicProjectionCanonicalIdSchema,
    action: publicDecisionResolutionActionSchema
  }).strict(),
  z.object({
    kind: z.literal('agent.run.cancel'),
    contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    runId: publicProjectionCanonicalIdSchema,
    expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    occurredAt: isoDateTimeSchema,
    reason: z.literal('user_requested')
  }).strict(),
  z.object({
    kind: z.literal('agent.inbox.enqueue'),
    contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    runId: publicProjectionCanonicalIdSchema,
    sessionId: publicProjectionCanonicalIdSchema,
    inputId: publicProjectionCanonicalIdSchema,
    delivery: z.enum(['next_turn', 'next_step']),
    content: z.string().min(1).max(100_000).refine(
      (value) => value.trim().length > 0,
      'Agent inbox input cannot contain only whitespace.'
    )
  }).strict(),
  z.object({
    kind: z.literal('agent.inbox.replace'),
    contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    runId: publicProjectionCanonicalIdSchema,
    inputId: publicProjectionCanonicalIdSchema,
    expectedInputVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    content: z.string().min(1).max(100_000).refine(
      (value) => value.trim().length > 0,
      'Agent inbox input cannot contain only whitespace.'
    )
  }).strict(),
  z.object({
    kind: z.literal('agent.inbox.remove'),
    contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    runId: publicProjectionCanonicalIdSchema,
    inputId: publicProjectionCanonicalIdSchema,
    expectedInputVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  }).strict(),
  z.object({
    kind: z.literal('agent.subagent.send'),
    contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    parentRunId: publicProjectionCanonicalIdSchema,
    childRunId: publicProjectionCanonicalIdSchema,
    sessionId: publicProjectionCanonicalIdSchema,
    inputId: publicProjectionCanonicalIdSchema,
    content: z.string().min(1).max(100_000).refine(
      (value) => value.trim().length > 0,
      'SubAgent input cannot contain only whitespace.'
    )
  }).strict(),
  z.object({
    kind: z.literal('agent.subagent.interrupt'),
    contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    parentRunId: publicProjectionCanonicalIdSchema,
    childRunId: publicProjectionCanonicalIdSchema,
    sessionId: publicProjectionCanonicalIdSchema,
    expectedChildVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    occurredAt: isoDateTimeSchema,
    reason: z.literal('user_requested')
  }).strict()
]);

export type RuntimeCommand = z.infer<typeof runtimeCommandSchema>;

export const runtimeResultSchema = z.discriminatedUnion('kind', [
  taskCenterPageSchema, taskCenterResetSchema, taskCenterNavigationResultSchema,
  taskCenterRelationsResultSchema,
  modelQualityResultSchema,
  ...productivityResultSchemas,
  ...productivityTaskIsolationResultSchemas,
  ...longMemoryResultSchemas,
  ...workspaceDocumentResultSchemas,
  z.object({ kind: z.literal('runtime.status'), status: runtimeStatusSchema }).strict(),
  z.object({ kind: z.literal('runtime.health'), health: runtimeHealthSchema }).strict(),
  z.object({
    kind: z.literal('model.qualification.completed'),
    modelId: publicProjectionCanonicalIdSchema,
    supportsTextChat: z.boolean(),
    supportsAgent: z.boolean(),
    supportsPlan: z.boolean(),
    supportsVision: z.boolean(),
    qualificationState: z.enum(['unknown', 'testing', 'qualified', 'rejected'])
  }).strict(),
  z.object({
    kind: z.literal('model.availability.completed'),
    modelId: publicProjectionCanonicalIdSchema,
    available: z.boolean()
  }).strict(),
  z.object({
    kind: z.literal('projection.snapshot'),
    snapshot: publicProjectionSnapshotSchema
  }).strict(),
  z.object({
    kind: z.literal('projection.commits'),
    batch: publicProjectionReadBatchSchema
  }).strict(),
  z.object({
    kind: z.literal('conversation.session.created'),
    sessionId: publicProjectionCanonicalIdSchema,
    version: z.literal(1)
  }).strict(),
  z.object({ kind: z.literal('projection.snapshot.manifest'),
    manifest: z.union([publicProjectionSnapshotManifestSchema, publicProjectionSnapshotPageResetSchema]) }).strict(),
  z.object({ kind: z.literal('projection.snapshot.page_result'), page: publicProjectionSnapshotPageResultSchema }).strict(),
  z.object({ kind: z.literal('projection.scope.batch'), batch: publicProjectionScopedReadBatchSchema }).strict(),
  z.object({ kind: z.literal('projection.view.manifest'),
    manifest: z.union([publicProjectionViewManifestSchema, publicProjectionSnapshotPageResetSchema]) }).strict(),
  z.object({ kind: z.literal('projection.view.page_result'), page: publicProjectionViewPageResultSchema }).strict(),
  z.object({ kind: z.literal('projection.messages.window_result'), window: publicProjectionMessageWindowResultSchema }).strict(),
  z.object({ kind: z.literal('projection.catalog.manifest'), manifest: z.union([publicProjectionCatalogManifestSchema, publicProjectionCatalogResetSchema]) }).strict(),
  z.object({ kind: z.literal('projection.catalog.page_result'), page: publicProjectionCatalogPageResultSchema }).strict(),
  z.object({ kind: z.literal('projection.catalog.detail_result'), detail: publicProjectionCatalogDetailResultSchema }).strict(),
  z.object({ kind: z.literal('projection.catalog.batch'), batch: publicProjectionCatalogBatchResultSchema }).strict(),
  z.object({ kind: z.literal('projection.features.window_result'), window: publicProjectionFeatureWindowResultSchema }).strict(),
  z.object({ kind: z.literal('projection.features.receipts_result'), batch: publicProjectionFeatureReceiptResultSchema }).strict(),
  z.object({ kind: z.literal('projection.run_document.root_result'), document: publicRunDocumentRootResultSchema }).strict(),
  z.object({ kind: z.literal('projection.run_document.metadata_result'), page: publicRunDocumentMetadataResultSchema }).strict(),
  z.object({ kind: z.literal('projection.run_document.inbox_result'), input: publicRunDocumentInboxResultSchema }).strict(),
  z.object({ kind: z.literal('projection.run_document.chunk_result'), chunk: publicRunDocumentChunkResultSchema }).strict(),
  z.object({ kind: z.literal('projection.messages.metadata_result'), window: publicMessageMetadataWindowResultSchema }).strict(),
  z.object({ kind: z.literal('projection.messages.body_result'), body: publicMessageBodyResultSchema }).strict(),
  z.object({ kind: z.literal('projection.conversation.receipts_result'), batch: publicConversationReceiptResultSchema }).strict(),
  z.object({ kind: z.literal('projection.conversation.inference_window_result'), window: publicConversationInferenceResultSchema }).strict(),
  z.object({
    kind: z.literal('conversation.session.updated'),
    sessionId: publicProjectionCanonicalIdSchema,
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  }).strict(),
  z.object({
    kind: z.literal('conversation.session.title.generated'),
    sessionId: publicProjectionCanonicalIdSchema,
    sessionVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    title: z.string().trim().min(1).max(80)
  }).strict(),
  z.object({
    kind: z.literal('conversation.session.forked'),
    sessionId: publicProjectionCanonicalIdSchema,
    version: z.literal(1),
    sourceSessionId: publicProjectionCanonicalIdSchema,
    boundary: conversationMessageReferenceSchema
  }).strict(),
  z.object({
    kind: z.literal('conversation.sessions.query_result'),
    items: z.array(z.object({
      sessionId: publicProjectionCanonicalIdSchema,
      workspaceId: publicProjectionCanonicalIdSchema,
      version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      title: z.string().trim().min(1).max(512),
      status: z.enum(['active', 'archived']),
      updatedAt: isoDateTimeSchema,
      lineage: z.object({
        sourceSessionId: publicProjectionCanonicalIdSchema,
        boundary: conversationMessageReferenceSchema
      }).strict().nullable(),
      matches: z.array(z.object({
        reference: conversationMessageReferenceSchema,
        role: z.enum(['user', 'assistant']),
        snippet: z.string().max(512)
      }).strict()).max(3)
    }).strict()).max(50)
  }).strict(),
  z.object({
    kind: z.literal('conversation.message.resolved'),
    reference: conversationMessageReferenceSchema,
    workspaceId: publicProjectionCanonicalIdSchema,
    role: z.enum(['user', 'assistant']),
    content: z.string().max(100_000),
    createdAt: isoDateTimeSchema
  }).strict(),
  z.object({
    kind: z.literal('skill.commands.query_result'),
    workspaceId: publicProjectionCanonicalIdSchema,
    catalogDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    complete: z.boolean(),
    source: z.enum(['fresh', 'last_good']),
    commands: z.array(z.object({
      name: z.string().regex(/^[a-z][a-z0-9_-]*$/u),
      description: z.string().min(1).max(2_000),
      revision: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
      layer: z.enum(['built_in', 'user', 'workspace'])
    }).strict()).max(1_024)
  }).strict(),
  z.object({
    kind: z.literal('skill.command.loaded'),
    workspaceId: publicProjectionCanonicalIdSchema,
    name: z.string().regex(/^[a-z][a-z0-9_-]*$/u),
    description: z.string().min(1).max(2_000),
    revision: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    layer: z.enum(['built_in', 'user', 'workspace']),
    body: z.string().max(1_000_000),
    resources: z.array(z.object({
      relativePath: z.string().min(1).max(512),
      mediaType: z.string().min(1).max(128),
      byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      revision: z.string().regex(/^sha256:[a-f0-9]{64}$/u)
    }).strict()).max(2_048)
  }).strict(),
  z.object({
    kind: z.literal('skill.command.resource'),
    workspaceId: publicProjectionCanonicalIdSchema,
    name: z.string().regex(/^[a-z][a-z0-9_-]*$/u),
    revision: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    relativePath: z.string().min(1).max(512),
    mediaType: z.string().min(1).max(128),
    encoding: z.enum(['utf8', 'base64']),
    content: z.string().max(300_000)
  }).strict(),
  z.object({
    kind: z.literal('agent.tool_result.detail'),
    runId: publicProjectionCanonicalIdSchema,
    workspaceId: publicProjectionCanonicalIdSchema,
    effectId: publicProjectionCanonicalIdSchema,
    toolCallId: publicProjectionCanonicalIdSchema,
    presentation: z.object({
      kind: z.enum([
        'generic', 'file_read', 'file_search', 'file_change', 'command',
        'terminal', 'browser', 'skill', 'external'
      ]),
      label: z.string().trim().min(1).max(128)
    }).strict(),
    status: z.enum(['succeeded', 'failed']),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    totalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    cursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    nextCursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    content: z.string().max(64 * 1024),
    complete: z.boolean()
  }).strict(),
  z.object({
    kind: z.literal('conversation.message.accepted'),
    sessionId: publicProjectionCanonicalIdSchema,
    sessionVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    messageId: publicProjectionCanonicalIdSchema,
    messageVersion: z.literal(1),
    sagaId: publicProjectionCanonicalIdSchema
  }).strict(),
  z.object({
    kind: z.literal('agent.decision.resolved'),
    runId: publicProjectionCanonicalIdSchema,
    decisionId: publicProjectionCanonicalIdSchema,
    runVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  }).strict(),
  z.object({
    kind: z.literal('agent.run.cancelled'),
    runId: publicProjectionCanonicalIdSchema,
    runVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  }).strict(),
  z.object({
    kind: z.literal('agent.run.cancellation.requested'),
    runId: publicProjectionCanonicalIdSchema,
    runVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  }).strict(),
  z.object({
    kind: z.literal('agent.inbox.enqueued'),
    runId: publicProjectionCanonicalIdSchema,
    runVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    inputId: publicProjectionCanonicalIdSchema,
    inputVersion: z.literal(1)
  }).strict(),
  z.object({
    kind: z.literal('agent.inbox.replaced'),
    runId: publicProjectionCanonicalIdSchema,
    runVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    inputId: publicProjectionCanonicalIdSchema,
    inputVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  }).strict(),
  z.object({
    kind: z.literal('agent.inbox.removed'),
    runId: publicProjectionCanonicalIdSchema,
    runVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    inputId: publicProjectionCanonicalIdSchema
  }).strict(),
  z.object({
    kind: z.literal('agent.subagent.input.sent'),
    parentRunId: publicProjectionCanonicalIdSchema,
    childRunId: publicProjectionCanonicalIdSchema,
    childRunVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    inputId: publicProjectionCanonicalIdSchema,
    inputVersion: z.literal(1)
  }).strict(),
  z.object({
    kind: z.literal('agent.subagent.interrupted'),
    parentRunId: publicProjectionCanonicalIdSchema,
    childRunId: publicProjectionCanonicalIdSchema,
    childRunVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    previousStatus: z.enum(['active', 'idle', 'inactive'])
  }).strict(),
  z.object({ kind: z.literal('acknowledged') }).strict()
]);

export type RuntimeResult = z.infer<typeof runtimeResultSchema>;

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
  publicDecisionActionTokenV1Schema,
  publicDecisionChoiceV3Schema,
  publicProjectionCanonicalIdSchema,
  publicProjectionFeatureV3Schema,
  publicProjectionReadBatchV3Schema,
  publicProjectionReadRequestV3Schema,
  publicProjectionSnapshotV3Schema
} from './public/projection-v3.js';
export * from './public/projection-v3.js';
export * from './public/decision-action-v1.js';
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
  'agent.proposals',
  'agent.runs',
  'agent.inbox',
  'agent.permissions',
  'agent.plans',
  'agent.tools',
  'agent.subagents',
  'models.local',
  'models.remote',
  'workspace.read',
  'workspace.write',
  'observability.diagnostics',
  'telemetry.export',
  'background.tasks',
  'scheduler',
  'resources',
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
    providerQualification: z.object({
      nativeTools: z.enum(['supported', 'unsupported', 'unknown']),
      textFallback: z.enum(['supported', 'unsupported', 'unknown']),
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
export type RunActivityStatus = z.infer<typeof runActivityStatusSchema>;

export const runFileChangeSchema = z.object({
  path: z.string().trim().min(1).max(32_768),
  changeKind: z.enum(['created', 'modified', 'deleted', 'observed']),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  checkpointId: nonEmptyIdSchema.optional(),
  beforeHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  afterHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  diffHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  diff: z.string().max(2 * 1024 * 1024).optional(),
  diffTruncated: z.boolean(),
  changedStartLine: z.number().int().positive().optional(),
  changedEndLine: z.number().int().positive().optional(),
  evidence: z.enum(['authoritative', 'observed'])
}).strict();
export type RunFileChange = z.infer<typeof runFileChangeSchema>;

export const runActivityNodeSchema = z
  .object({
    activityType: z.literal('tool'),
    activityId: nonEmptyIdSchema,
    runId: nonEmptyIdSchema,
    toolCallId: nonEmptyIdSchema,
    toolName: z.string().trim().min(1).max(256),
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
export type RunActivityNode = z.infer<typeof runActivityNodeSchema>;

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
export type RunSystemActivity = z.infer<typeof runSystemActivitySchema>;

export const runActivitySchema = z.discriminatedUnion('activityType', [
  runActivityNodeSchema,
  runSystemActivitySchema
]);
export type RunActivity = z.infer<typeof runActivitySchema>;

export const runActivityEdgeSchema = z.object({
  edgeId: nonEmptyIdSchema,
  runId: nonEmptyIdSchema,
  sourceActivityId: nonEmptyIdSchema,
  targetActivityId: nonEmptyIdSchema,
  kind: z.enum(['sequence', 'verification', 'delegation'])
}).strict();
export type RunActivityEdge = z.infer<typeof runActivityEdgeSchema>;

export const runActivityGraphSchema = z.object({
  runId: nonEmptyIdSchema,
  sessionId: nonEmptyIdSchema.optional(),
  status: runStatusSchema,
  timing: z.object({
    activeDurationMs: z.number().int().nonnegative(),
    activeSince: isoDateTimeSchema.optional()
  }).strict(),
  nodes: z.array(runActivityNodeSchema).max(20_000),
  edges: z.array(runActivityEdgeSchema).max(40_000),
  systemActivities: z.array(runSystemActivitySchema).max(10_000),
  updatedAt: isoDateTimeSchema
}).strict();
export type RunActivityGraph = z.infer<typeof runActivityGraphSchema>;

export const runActivityDetailSchema = z.object({
  activityId: nonEmptyIdSchema,
  runId: nonEmptyIdSchema,
  toolCallId: nonEmptyIdSchema,
  toolName: z.string().trim().min(1).max(256),
  args: z.record(z.string(), jsonValueSchema).optional(),
  command: z.string().max(64 * 1024).optional(),
  cwd: z.string().max(32_768).optional(),
  exitCode: z.number().int().optional(),
  stdoutPreview: z.string().max(64 * 1024).optional(),
  stderrPreview: z.string().max(64 * 1024).optional(),
  outputPreview: z.string().max(64 * 1024).optional(),
  resultSummary: z.string().max(64 * 1024).optional(),
  errorMessage: z.string().max(64 * 1024).optional(),
  permissionAudit: z.record(z.string(), jsonValueSchema).optional(),
  outputTruncated: z.boolean(),
  redacted: z.boolean(),
  fileChanges: z.array(runFileChangeSchema).max(2_000)
}).strict();
export type RunActivityDetail = z.infer<typeof runActivityDetailSchema>;

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

export const resourceRecordSchema = resourceReferenceSchema.extend({
  owner: z.object({
    type: z.string().trim().min(1).max(128),
    id: nonEmptyIdSchema
  }).strict(),
  expiresAt: isoDateTimeSchema.optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
}).strict();
export type ResourceRecord = z.infer<typeof resourceRecordSchema>;

export const memoryRecordSchema = z.object({
  memoryId: nonEmptyIdSchema,
  scope: z.enum(['global', 'session', 'project', 'task']),
  scopeId: nonEmptyIdSchema.optional(),
  memoryType: z.enum([
    'preference',
    'habit',
    'decision',
    'fact',
    'lesson',
    'project_note',
    'recent_state',
    'task_state',
    'known_issue',
    'tech_stack'
  ]),
  key: z.string().trim().min(1).max(512).optional(),
  value: z.string().max(200_000),
  summary: z.string().max(4_096).optional(),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  lifecycleState: z.enum(['candidate', 'active', 'rejected', 'superseded', 'expired']),
  provenance: z.object({
    origin: z.enum(['user', 'model_summary', 'tool_ledger', 'workspace', 'system']),
    sourceId: nonEmptyIdSchema.optional(),
    evidence: z.string().max(4_096).optional()
  }).strict(),
  sensitivity: z.enum(['public', 'workspace', 'sensitive']),
  retentionUntil: isoDateTimeSchema.optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  lastUsedAt: isoDateTimeSchema.optional(),
  supersedesId: nonEmptyIdSchema.optional()
}).strict();
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;

export const taskCheckpointSchema = z.object({
  checkpointId: nonEmptyIdSchema,
  runId: nonEmptyIdSchema,
  toolName: z.string().trim().min(1).max(128),
  path: z.string().trim().min(1).max(32_768),
  beforeHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  afterHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  currentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  comparison: z.enum(['matches', 'modified', 'missing', 'unexpected_file']),
  restorable: z.boolean(),
  diff: z.string().max(2 * 1024 * 1024).optional(),
  createdAt: isoDateTimeSchema
}).strict();
export type TaskCheckpoint = z.infer<typeof taskCheckpointSchema>;

export const runtimeEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('companion.reasoning.delta'),
    runId: nonEmptyIdSchema,
    sessionId: nonEmptyIdSchema,
    messageId: nonEmptyIdSchema,
    text: z.string().min(1).max(64_000),
    source: z.enum(['provider', 'summary']),
    startedAt: isoDateTimeSchema
  }).strict(),
  z.object({ kind: z.literal('companion.token.delta'), runId: nonEmptyIdSchema, sessionId: nonEmptyIdSchema, messageId: nonEmptyIdSchema, text: z.string().min(1).max(64_000) }).strict(),
  z.object({ kind: z.literal('companion.message.changed'), message: companionMessageSchema }).strict(),
  z.object({
    kind: z.literal('companion.message.removed'),
    sessionId: nonEmptyIdSchema,
    messageId: nonEmptyIdSchema
  }).strict(),
  z.object({ kind: z.literal('agent.proposal.changed'), proposal: agentProposalSchema }).strict(),
  z.object({ kind: z.literal('run.changed'), run: runSummarySchema }).strict(),
  z.object({ kind: z.literal('run.activity'), activity: runActivitySchema }).strict(),
  z.object({ kind: z.literal('permission.changed'), request: permissionRequestSchema }).strict(),
  z.object({ kind: z.literal('planHandoff.changed'), handoff: planHandoffSchema }).strict(),
  z.object({
    kind: z.literal('projection.changed'),
    feature: publicProjectionFeatureV3Schema
  }).strict(),
  z.object({ kind: z.literal('trace.appended'), entry: traceEntrySchema }).strict()
]);
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;

export const runtimeEventEnvelopeSchema = z
  .object({
    eventId: nonEmptyIdSchema,
    cursor: z.number().int().positive(),
    schemaVersion: z.literal('2.0'),
    aggregateType: z.enum([
      'run',
      'companion',
      'permission',
      'plan_handoff',
      'proposal',
      'projection',
      'trace'
    ]),
    aggregateId: nonEmptyIdSchema,
    aggregateVersion: z.number().int().positive(),
    correlationId: nonEmptyIdSchema.optional(),
    causationId: nonEmptyIdSchema.optional(),
    occurredAt: isoDateTimeSchema,
    event: runtimeEventSchema
  })
  .strict();
export type RuntimeEventEnvelope = z.infer<typeof runtimeEventEnvelopeSchema>;

export const runtimeSnapshotSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    capturedAt: isoDateTimeSchema,
    runs: z.array(runSummarySchema),
    permissions: z.array(permissionRequestSchema),
    planHandoffs: z.array(planHandoffSchema),
    proposals: z.array(agentProposalSchema)
  })
  .strict();
export type RuntimeSnapshot = z.infer<typeof runtimeSnapshotSchema>;

const emptyCommand = <T extends string>(kind: T) => z.object({ kind: z.literal(kind) }).strict();

export const publicDecisionResolutionActionV3Schema = z.object({
  contractVersion: z.literal(PUBLIC_DECISION_ACTION_CONTRACT_VERSION),
  actionToken: publicDecisionActionTokenV1Schema,
  choice: publicDecisionChoiceV3Schema
}).strict();
export type PublicDecisionResolutionActionV3 = z.infer<
  typeof publicDecisionResolutionActionV3Schema
>;

export const conversationMessageExecutionV3Schema = z.object({
  mode: z.enum(['agent', 'plan']),
  modelId: publicProjectionCanonicalIdSchema.optional(),
  inference: modelInferenceOptionsSchema.optional(),
  routingStrategy: chatRoutingStrategySchema.optional()
}).strict();
export type ConversationMessageExecutionV3 = z.infer<
  typeof conversationMessageExecutionV3Schema
>;

export const runtimeCommandSchema = z.discriminatedUnion('kind', [
  emptyCommand('runtime.status.get'),
  z.object({
    kind: z.literal('projection.snapshot.get'),
    contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION)
  }).strict(),
  z.object({
    kind: z.literal('projection.commits.read'),
    request: publicProjectionReadRequestV3Schema
  }).strict(),
  z.object({
    kind: z.literal('conversation.session.create.v3'),
    contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    sessionId: publicProjectionCanonicalIdSchema,
    workspaceId: publicProjectionCanonicalIdSchema
  }).strict(),
  z.object({
    kind: z.literal('conversation.message.accept.v3'),
    contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    sessionId: publicProjectionCanonicalIdSchema,
    workspaceId: publicProjectionCanonicalIdSchema,
    expectedSessionVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    messageId: publicProjectionCanonicalIdSchema,
    content: z.string().min(1).max(100_000).refine(
      (value) => value.trim().length > 0,
      'Conversation message cannot contain only whitespace.'
    ),
    execution: conversationMessageExecutionV3Schema.optional()
  }).strict(),
  z.object({
    kind: z.literal('agent.decision.resolve.v3'),
    contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    runId: publicProjectionCanonicalIdSchema,
    decisionId: publicProjectionCanonicalIdSchema,
    action: publicDecisionResolutionActionV3Schema
  }).strict(),
  z.object({
    kind: z.literal('agent.run.cancel.v3'),
    contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    runId: publicProjectionCanonicalIdSchema,
    expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    occurredAt: isoDateTimeSchema,
    reason: z.literal('user_requested')
  }).strict(),
  z.object({
    kind: z.literal('agent.inbox.enqueue.v3'),
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
    kind: z.literal('agent.inbox.replace.v3'),
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
    kind: z.literal('agent.inbox.remove.v3'),
    contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    runId: publicProjectionCanonicalIdSchema,
    inputId: publicProjectionCanonicalIdSchema,
    expectedInputVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  }).strict()
]);

export type RuntimeCommand = z.infer<typeof runtimeCommandSchema>;

export const runtimeResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('runtime.status'), status: runtimeStatusSchema }).strict(),
  z.object({
    kind: z.literal('projection.snapshot'),
    snapshot: publicProjectionSnapshotV3Schema
  }).strict(),
  z.object({
    kind: z.literal('projection.commits'),
    batch: publicProjectionReadBatchV3Schema
  }).strict(),
  z.object({
    kind: z.literal('conversation.session.created.v3'),
    sessionId: publicProjectionCanonicalIdSchema,
    version: z.literal(1)
  }).strict(),
  z.object({
    kind: z.literal('conversation.message.accepted.v3'),
    sessionId: publicProjectionCanonicalIdSchema,
    sessionVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    messageId: publicProjectionCanonicalIdSchema,
    messageVersion: z.literal(1),
    sagaId: publicProjectionCanonicalIdSchema
  }).strict(),
  z.object({
    kind: z.literal('agent.decision.resolved.v3'),
    runId: publicProjectionCanonicalIdSchema,
    decisionId: publicProjectionCanonicalIdSchema,
    runVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  }).strict(),
  z.object({
    kind: z.literal('agent.run.cancelled.v3'),
    runId: publicProjectionCanonicalIdSchema,
    runVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  }).strict(),
  z.object({
    kind: z.literal('agent.inbox.enqueued.v3'),
    runId: publicProjectionCanonicalIdSchema,
    runVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    inputId: publicProjectionCanonicalIdSchema,
    inputVersion: z.literal(1)
  }).strict(),
  z.object({
    kind: z.literal('agent.inbox.replaced.v3'),
    runId: publicProjectionCanonicalIdSchema,
    runVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    inputId: publicProjectionCanonicalIdSchema,
    inputVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  }).strict(),
  z.object({
    kind: z.literal('agent.inbox.removed.v3'),
    runId: publicProjectionCanonicalIdSchema,
    runVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    inputId: publicProjectionCanonicalIdSchema
  }).strict(),
  z.object({ kind: z.literal('acknowledged') }).strict()
]);

export type RuntimeResult = z.infer<typeof runtimeResultSchema>;

export const publicRuntimeApiSchema = z
  .object({
    command: runtimeCommandSchema,
    requestId: nonEmptyIdSchema
  })
  .strict();

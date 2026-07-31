import { z } from 'zod';
import {
  isoDateTimeSchema,
  jsonValueSchema,
  nonEmptyIdSchema,
  resourceReferenceSchema
} from './common.js';
export type { JsonValue } from './common.js';

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
  'scheduler',
  'resources',
  'memory.manage',
  'browser.web'
]);

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
  z.object({ kind: z.literal('runtime.status.changed'), status: runtimeStatusSchema }).strict(),
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
  z.object({ kind: z.literal('trace.appended'), entry: traceEntrySchema }).strict()
]);
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;

export const runtimeEventEnvelopeSchema = z
  .object({
    eventId: nonEmptyIdSchema,
    cursor: z.number().int().positive(),
    schemaVersion: z.literal('2.0'),
    aggregateType: z.enum([
      'runtime',
      'run',
      'companion',
      'permission',
      'plan_handoff',
      'proposal',
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

export const runtimeCommandSchema = z.discriminatedUnion('kind', [
  emptyCommand('runtime.status.get'),
  emptyCommand('runtime.snapshot.get'),
  z.object({
    kind: z.literal('events.replay'),
    afterCursor: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(2_000).default(200)
  }).strict(),
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
  z.object({ kind: z.literal('companion.workspaces.purge'), workspaceId: nonEmptyIdSchema }).strict(),
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
    agentMode: z.literal('plan').optional(),
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
  z.object({ kind: z.literal('runActivities.get'), runId: nonEmptyIdSchema }).strict(),
  z.object({
    kind: z.literal('runActivityDetails.get'),
    runId: nonEmptyIdSchema,
    activityId: nonEmptyIdSchema
  }).strict(),
  z.object({ kind: z.literal('runs.cancel'), runId: nonEmptyIdSchema }).strict(),
  z.object({
    kind: z.literal('runs.recover'),
    runId: nonEmptyIdSchema,
    expectedAggregateVersion: z.number().int().positive(),
    decision: z.enum(['resume', 'cancel', 'mark_failed'])
  }).strict(),
  z.object({
    kind: z.literal('runs.resume'),
    runId: nonEmptyIdSchema,
    expectedAggregateVersion: z.number().int().positive(),
    budget: runBudgetSchema.partial().optional()
  }).strict(),
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
  z.object({
    kind: z.literal('resources.list'),
    ownerType: z.string().trim().min(1).max(128).optional(),
    ownerId: nonEmptyIdSchema.optional(),
    limit: z.number().int().min(1).max(2_000).default(200)
  }).strict(),
  z.object({ kind: z.literal('resources.get'), resourceId: nonEmptyIdSchema }).strict(),
  z.object({
    kind: z.literal('resources.update'),
    resourceId: nonEmptyIdSchema,
    name: z.string().trim().min(1).max(512).optional(),
    lifecycle: z.enum(['temporary', 'session', 'run', 'persistent']).optional(),
    sensitivity: z.enum(['public', 'workspace', 'sensitive', 'secret']).optional(),
    provenanceSummary: z.string().trim().min(1).max(1_024).nullable().optional(),
    expiresAt: isoDateTimeSchema.nullable().optional()
  }).strict().refine(
    (input) => Object.keys(input).some((key) => key !== 'kind' && key !== 'resourceId'),
    { message: 'At least one resource field must be updated.' }
  ),
  z.object({ kind: z.literal('resources.delete'), resourceId: nonEmptyIdSchema }).strict(),
  z.object({
    kind: z.literal('memories.list'),
    scope: z.enum(['global', 'session', 'project', 'task']).optional(),
    scopeId: nonEmptyIdSchema.optional(),
    lifecycleState: z.enum(['candidate', 'active', 'rejected', 'superseded', 'expired']).optional(),
    limit: z.number().int().min(1).max(2_000).default(200)
  }).strict(),
  z.object({ kind: z.literal('memories.get'), memoryId: nonEmptyIdSchema }).strict(),
  z.object({
    kind: z.literal('memories.update'),
    memoryId: nonEmptyIdSchema,
    value: z.string().min(1).max(200_000).optional(),
    summary: z.string().max(4_096).nullable().optional(),
    importance: z.number().min(0).max(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
    lifecycleState: z.enum(['candidate', 'active', 'rejected', 'expired']).optional(),
    sensitivity: z.enum(['public', 'workspace', 'sensitive']).optional(),
    retentionUntil: isoDateTimeSchema.nullable().optional()
  }).strict().superRefine((input, context) => {
    const fields = Object.keys(input).filter((key) => key !== 'kind' && key !== 'memoryId');
    if (fields.length === 0) {
      context.addIssue({ code: 'custom', message: 'At least one memory field must be updated.' });
    }
    const contentFields = ['value', 'summary', 'importance', 'confidence', 'sensitivity', 'retentionUntil'];
    if (
      contentFields.some((field) => field in input)
      && input.lifecycleState
      && input.lifecycleState !== 'active'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['lifecycleState'],
        message: 'Edited memory content must create an active replacement.'
      });
    }
  }),
  z.object({ kind: z.literal('memories.delete'), memoryId: nonEmptyIdSchema }).strict(),
  z.object({ kind: z.literal('taskCheckpoints.list'), runId: nonEmptyIdSchema }).strict(),
  z.object({
    kind: z.literal('taskCheckpoints.get'),
    runId: nonEmptyIdSchema,
    checkpointId: nonEmptyIdSchema
  }).strict(),
  z.object({
    kind: z.literal('taskCheckpoints.compare'),
    runId: nonEmptyIdSchema,
    checkpointId: nonEmptyIdSchema
  }).strict(),
  z.object({
    kind: z.literal('taskCheckpoints.restore'),
    runId: nonEmptyIdSchema,
    checkpointId: nonEmptyIdSchema
  }).strict(),
  z.object({ kind: z.literal('trace.list'), runId: nonEmptyIdSchema.optional(), limit: z.number().int().min(1).max(2_000).default(200) }).strict()
]);

export type RuntimeCommand = z.infer<typeof runtimeCommandSchema>;

export const runtimeResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('runtime.status'), status: runtimeStatusSchema }).strict(),
  z.object({ kind: z.literal('runtime.snapshot'), snapshot: runtimeSnapshotSchema }).strict(),
  z.object({
    kind: z.literal('events.replay'),
    events: z.array(runtimeEventEnvelopeSchema),
    nextCursor: z.number().int().nonnegative()
  }).strict(),
  z.object({ kind: z.literal('models.catalog'), models: z.array(modelSummarySchema) }).strict(),
  z.object({ kind: z.literal('companion.sessions'), sessions: z.array(conversationSessionSchema) }).strict(),
  z.object({ kind: z.literal('companion.session'), session: conversationSessionSchema }).strict(),
  z.object({
    kind: z.literal('companion.workspace.purged'),
    workspaceId: nonEmptyIdSchema,
    deletedSessions: z.number().int().nonnegative(),
    deletedAgentContexts: z.number().int().nonnegative()
  }).strict(),
  z.object({ kind: z.literal('companion.messages'), messages: z.array(companionMessageSchema) }).strict(),
  z.object({
    kind: z.literal('companion.chat.accepted'),
    runId: nonEmptyIdSchema,
    sessionId: nonEmptyIdSchema,
    executionMode: z.enum(['companion', 'agent-plan'])
  }).strict(),
  z.object({ kind: z.literal('agent.proposals'), proposals: z.array(agentProposalSchema) }).strict(),
  z.object({ kind: z.literal('agent.proposal'), proposal: agentProposalSchema }).strict(),
  z.object({ kind: z.literal('runs'), runs: z.array(runSummarySchema) }).strict(),
  z.object({ kind: z.literal('run'), run: runSummarySchema }).strict(),
  z.object({ kind: z.literal('runActivityGraph'), graph: runActivityGraphSchema }).strict(),
  z.object({ kind: z.literal('runActivityDetail'), detail: runActivityDetailSchema }).strict(),
  z.object({ kind: z.literal('permissions'), requests: z.array(permissionRequestSchema) }).strict(),
  z.object({ kind: z.literal('permission'), request: permissionRequestSchema }).strict(),
  z.object({ kind: z.literal('planHandoffs'), handoffs: z.array(planHandoffSchema) }).strict(),
  z.object({ kind: z.literal('planHandoff'), handoff: planHandoffSchema }).strict(),
  z.object({ kind: z.literal('resources'), resources: z.array(resourceRecordSchema) }).strict(),
  z.object({ kind: z.literal('resource'), resource: resourceRecordSchema }).strict(),
  z.object({ kind: z.literal('memories'), memories: z.array(memoryRecordSchema) }).strict(),
  z.object({ kind: z.literal('memory'), memory: memoryRecordSchema }).strict(),
  z.object({ kind: z.literal('taskCheckpoints'), checkpoints: z.array(taskCheckpointSchema) }).strict(),
  z.object({ kind: z.literal('taskCheckpoint'), checkpoint: taskCheckpointSchema }).strict(),
  z.object({
    kind: z.literal('taskCheckpointRestore'),
    source: taskCheckpointSchema,
    restore: taskCheckpointSchema
  }).strict(),
  z.object({ kind: z.literal('trace'), entries: z.array(traceEntrySchema) }).strict(),
  z.object({ kind: z.literal('acknowledged') }).strict()
]);

export type RuntimeResult = z.infer<typeof runtimeResultSchema>;

export const publicRuntimeApiSchema = z
  .object({
    command: runtimeCommandSchema,
    requestId: nonEmptyIdSchema
  })
  .strict();

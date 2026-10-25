import { z } from 'zod';
import { canonicalUtcTimestampSchema } from '../common.js';
import { modelQualitySummarySchema } from './stored-model-quality-summary.js';

import { imageAttachmentRefSchema } from './attachments.js';

export const PUBLIC_PROJECTION_CONTRACT_VERSION = '5.0' as const;
export const PUBLIC_PROJECTION_HISTORY_DOMAIN = 'ariadne-public-projection-v4' as const;

export const publicProjectionCanonicalIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const publicProjectionCanonicalTimestampSchema = canonicalUtcTimestampSchema;

const versionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const cursorSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const boundedLabelSchema = z.string().trim().min(1).max(512);
const boundedTextSchema = z.string().max(100_000);

export const PUBLIC_PROJECTION_GENESIS_DIGEST = (
  `sha256:${'0'.repeat(64)}`
) as `sha256:${string}`;

export const publicProjectionDigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/u);

export const publicSessionProjectionSchema = z.object({
  sessionId: publicProjectionCanonicalIdSchema,
  workspaceId: publicProjectionCanonicalIdSchema,
  version: versionSchema,
  title: boundedLabelSchema,
  pinned: z.boolean(),
  status: z.enum(['active', 'archived']),
  createdAt: publicProjectionCanonicalTimestampSchema,
  updatedAt: publicProjectionCanonicalTimestampSchema
}).strict().superRefine((value, context) => {
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    context.addIssue({
      code: 'custom',
      path: ['updatedAt'],
      message: 'updatedAt cannot precede createdAt.'
    });
  }
});
export type PublicSessionProjection = z.infer<typeof publicSessionProjectionSchema>;

export const publicMessageProjectionSchema = z.object({
  messageId: publicProjectionCanonicalIdSchema,
  sessionId: publicProjectionCanonicalIdSchema,
  runId: publicProjectionCanonicalIdSchema.optional(),
  version: versionSchema,
  reference: z.object({
    sessionId: publicProjectionCanonicalIdSchema,
    messageId: publicProjectionCanonicalIdSchema,
    messageVersion: versionSchema,
    contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u)
  }).strict().optional(),
  role: z.enum(['user', 'assistant', 'system']),
  content: boundedTextSchema,
  attachments: z.array(imageAttachmentRefSchema).min(1).max(4).optional(),
  status: z.enum(['streaming', 'completed', 'interrupted', 'failed']),
  createdAt: publicProjectionCanonicalTimestampSchema,
  updatedAt: publicProjectionCanonicalTimestampSchema
}).strict().superRefine((value, context) => {
  if (value.content.trim().length === 0 && value.attachments === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['content'],
      message: 'A projected Message requires text or an image attachment.'
    });
  }
  if (value.attachments !== undefined && value.role !== 'user') {
    context.addIssue({
      code: 'custom',
      path: ['attachments'],
      message: 'Only projected user Messages may contain image attachments.'
    });
  }
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    context.addIssue({
      code: 'custom',
      path: ['updatedAt'],
      message: 'updatedAt cannot precede createdAt.'
    });
  }
});
export type PublicMessageProjection = z.infer<typeof publicMessageProjectionSchema>;

export const publicToolActivityProjectionSchema = z.object({
  activityId: publicProjectionCanonicalIdSchema,
  callId: publicProjectionCanonicalIdSchema,
  toolName: publicProjectionCanonicalIdSchema,
  presentation: z.object({
    kind: z.enum([
      'generic',
      'file_read',
      'file_search',
      'file_change',
      'command',
      'terminal',
      'browser',
      'skill',
      'external'
    ]),
    label: z.string().trim().min(1).max(128)
  }).strict().optional(),
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  detailAvailable: z.boolean().default(false),
  occurredAt: publicProjectionCanonicalTimestampSchema,
  startedAt: publicProjectionCanonicalTimestampSchema.optional(),
  completedAt: publicProjectionCanonicalTimestampSchema.optional()
}).strict();
export type PublicToolActivityProjection = z.infer<
  typeof publicToolActivityProjectionSchema
>;

export const publicAgentInboxInputSchema = z.object({
  inputId: publicProjectionCanonicalIdSchema,
  messageId: publicProjectionCanonicalIdSchema,
  version: versionSchema,
  delivery: z.enum(['next_turn', 'next_step']),
  content: boundedTextSchema,
  source: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('live_work'),
      jobId: publicProjectionCanonicalIdSchema,
      workKind: publicProjectionCanonicalIdSchema,
      status: z.enum(['completed', 'killed', 'failed', 'interrupted'])
    }).strict(),
    z.object({
      kind: z.literal('user_question_answer'),
      decisionId: publicProjectionCanonicalIdSchema,
      questionDigest: publicProjectionDigestSchema
    }).strict()
  ]).optional(),
  state: z.enum(['queued', 'claimed']),
  queuedAt: publicProjectionCanonicalTimestampSchema,
  updatedAt: publicProjectionCanonicalTimestampSchema,
  claimedTurnId: publicProjectionCanonicalIdSchema.optional()
}).strict();
export type PublicAgentInboxInput = z.infer<typeof publicAgentInboxInputSchema>;

export const publicRunProjectionSchema = z.object({
  runId: publicProjectionCanonicalIdSchema,
  sessionId: publicProjectionCanonicalIdSchema.optional(),
  sourceMessageId: publicProjectionCanonicalIdSchema.optional(),
  parentRunId: publicProjectionCanonicalIdSchema.optional(),
  delegationId: publicProjectionCanonicalIdSchema.optional(),
  subagentMode: z.enum(['one_shot', 'continuable']).optional(),
  subagentProviderId: publicProjectionCanonicalIdSchema.optional(),
  version: versionSchema,
  title: boundedLabelSchema,
  status: z.enum([
    'queued',
    'running',
    'waiting_permission',
    'waiting_decision',
    'waiting_budget',
    'waiting_children',
    'cancelling',
    'paused',
    'completed',
    'failed',
    'cancelled',
    'interrupted'
  ]),
  label: boundedLabelSchema,
  /** A durable cancellation is pending; unresolved Tool outcomes still require recovery. */
  cancellationPending: z.boolean().optional(),
  progress: z.number().min(0).max(1).optional(),
  toolActivities: z.array(publicToolActivityProjectionSchema).max(1_000).default([]),
  inbox: z.array(publicAgentInboxInputSchema).max(1_000).default([]),
  interactionMessages: z.array(publicMessageProjectionSchema).max(1_000).default([]),
  updatedAt: publicProjectionCanonicalTimestampSchema,
  startedAt: publicProjectionCanonicalTimestampSchema.optional(),
  completedAt: publicProjectionCanonicalTimestampSchema.optional()
}).strict().superRefine((value, context) => {
  if (
    (value.parentRunId === undefined) !== (value.delegationId === undefined)
    || (value.parentRunId === undefined) !== (value.subagentMode === undefined)
    || (value.parentRunId === undefined) !== (value.subagentProviderId === undefined)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['parentRunId'],
      message: 'SubAgent parent, delegation, mode, and provider identity must appear together.'
    });
  }
  if (
    value.startedAt !== undefined
    && Date.parse(value.updatedAt) < Date.parse(value.startedAt)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['updatedAt'],
      message: 'updatedAt cannot precede startedAt.'
    });
  }
  if (
    value.completedAt !== undefined
    && value.startedAt !== undefined
    && Date.parse(value.completedAt) < Date.parse(value.startedAt)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['completedAt'],
      message: 'completedAt cannot precede startedAt.'
    });
  }
});
export type PublicRunProjection = z.infer<typeof publicRunProjectionSchema>;

export const PUBLIC_DECISION_ACTION_CONTRACT_VERSION = '1.0' as const;

export const publicDecisionChoiceSchema = z.enum([
  'allow_once',
  'allow_run',
  'deny',
  'approve',
  'reject',
  'retry',
  'mark_succeeded',
  'mark_failed',
  'cancel_run',
  'resume',
  'answer'
]);
export type PublicDecisionChoice = z.infer<typeof publicDecisionChoiceSchema>;

export const publicDecisionActionTokenSchema = publicProjectionCanonicalIdSchema.regex(
  /^decision-action\.v1:[0-9a-f]{64}$/u
);

export const publicDecisionActionSchema = z.object({
  contractVersion: z.literal(PUBLIC_DECISION_ACTION_CONTRACT_VERSION),
  actionToken: publicDecisionActionTokenSchema,
  choices: z.array(publicDecisionChoiceSchema).min(1).max(4)
}).strict().superRefine((value, context) => {
  if (new Set(value.choices).size !== value.choices.length) {
    context.addIssue({
      code: 'custom',
      path: ['choices'],
      message: 'Decision action choices must be unique.'
    });
  }
});
export type PublicDecisionAction = z.infer<typeof publicDecisionActionSchema>;

const publicDecisionKindSchema = z.enum([
  'permission',
  'plan',
  'recovery',
  'budget',
  'user_question'
]);

const publicDecisionChoicesByKind = {
  permission: ['allow_once', 'allow_run', 'deny'],
  plan: ['approve', 'reject'],
  recovery: ['retry', 'mark_succeeded', 'mark_failed', 'cancel_run'],
  budget: ['resume', 'cancel_run'],
  user_question: ['answer']
} as const satisfies Record<
  z.infer<typeof publicDecisionKindSchema>,
  readonly PublicDecisionChoice[]
>;

export const PUBLIC_DECISION_PRESENTATION_CONTRACT_VERSION = '1.0' as const;

const publicDecisionHeadlineSchema = z.string().trim().min(1).max(256);
const publicDecisionSummarySchema = z.string().trim().min(1).max(2_048);
function publicDecisionIdentifierListSchema(minimum: 0 | 1) {
  return z
  .array(publicProjectionCanonicalIdSchema)
  .min(minimum)
  .max(64)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: 'custom',
        message: 'Decision presentation identifiers must be unique.'
      });
    }
    for (let index = 1; index < values.length; index += 1) {
      if (values[index - 1]! >= values[index]!) {
        context.addIssue({
          code: 'custom',
          path: [index],
          message: 'Decision presentation identifiers must be code-unit sorted.'
        });
      }
    }
  });
}

export const publicPlanStepImpactSchema = z.enum([
  'read_only',
  'workspace_change',
  'command_execution',
  'network_access',
  'external_side_effect',
  'mixed'
]);
export type PublicPlanStepImpact = z.infer<typeof publicPlanStepImpactSchema>;

/**
 * The only Plan payload fragment that a public projector may consume.
 * Protected Plan payloads may contain additional private execution data, but
 * it can never be copied or inferred into this strict, explicitly public DTO.
 */
export const publicPlanDecisionPresentationSourceSchema = z.object({
  contractVersion: z.literal(PUBLIC_DECISION_PRESENTATION_CONTRACT_VERSION),
  summary: publicDecisionSummarySchema,
  impactSummary: publicDecisionSummarySchema,
  steps: z.array(z.object({
    title: z.string().trim().min(1).max(256),
    summary: z.string().trim().min(1).max(1_024),
    impact: publicPlanStepImpactSchema
  }).strict()).min(1).max(32)
}).strict();
export type PublicPlanDecisionPresentationSource = z.infer<
  typeof publicPlanDecisionPresentationSourceSchema
>;

export const publicPermissionDecisionPresentationSchema = z.object({
  contractVersion: z.literal(PUBLIC_DECISION_PRESENTATION_CONTRACT_VERSION),
  kind: z.literal('permission'),
  headline: publicDecisionHeadlineSchema,
  summary: publicDecisionSummarySchema,
  toolName: publicProjectionCanonicalIdSchema,
  capabilityIds: publicDecisionIdentifierListSchema(1),
  scopeIds: publicDecisionIdentifierListSchema(0),
  resourceSummary: publicDecisionSummarySchema
}).strict();

export const publicPlanDecisionPresentationSchema = z.object({
  contractVersion: z.literal(PUBLIC_DECISION_PRESENTATION_CONTRACT_VERSION),
  kind: z.literal('plan'),
  headline: publicDecisionHeadlineSchema,
  summary: publicDecisionSummarySchema,
  impactSummary: publicDecisionSummarySchema,
  approvalScope: z.literal('continue_run_with_presented_plan'),
  steps: publicPlanDecisionPresentationSourceSchema.shape.steps
}).strict();

const publicRecoveryDecisionPresentationSchema = z.object({
  contractVersion: z.literal(PUBLIC_DECISION_PRESENTATION_CONTRACT_VERSION),
  kind: z.literal('recovery'),
  headline: publicDecisionHeadlineSchema,
  summary: publicDecisionSummarySchema
}).strict();

const publicBudgetDecisionPresentationSchema = z.object({
  contractVersion: z.literal(PUBLIC_DECISION_PRESENTATION_CONTRACT_VERSION),
  kind: z.literal('budget'),
  headline: publicDecisionHeadlineSchema,
  summary: publicDecisionSummarySchema
}).strict();

export const publicUserQuestionDecisionPresentationSchema = z.object({
  contractVersion: z.literal(PUBLIC_DECISION_PRESENTATION_CONTRACT_VERSION),
  kind: z.literal('user_question'),
  headline: publicDecisionHeadlineSchema,
  question: z.string().trim().min(1).max(8_192),
  options: z.array(z.object({
    optionId: publicProjectionCanonicalIdSchema,
    label: z.string().trim().min(1).max(256),
    description: z.string().trim().min(1).max(1_024).optional()
  }).strict()).min(2).max(8).optional(),
  allowsFreeText: z.literal(true)
}).strict().superRefine((value, context) => {
  if (
    value.options !== undefined
    && new Set(value.options.map((option) => option.optionId)).size !== value.options.length
  ) {
    context.addIssue({
      code: 'custom',
      path: ['options'],
      message: 'User-question option IDs must be unique.'
    });
  }
});

export const publicDecisionPresentationSchema = z.discriminatedUnion('kind', [
  publicPermissionDecisionPresentationSchema,
  publicPlanDecisionPresentationSchema,
  publicRecoveryDecisionPresentationSchema,
  publicBudgetDecisionPresentationSchema,
  publicUserQuestionDecisionPresentationSchema
]);
export type PublicDecisionPresentation = z.infer<
  typeof publicDecisionPresentationSchema
>;

export const publicDecisionProjectionSchema = z.object({
  decisionId: publicProjectionCanonicalIdSchema,
  runId: publicProjectionCanonicalIdSchema,
  sessionId: publicProjectionCanonicalIdSchema,
  version: versionSchema,
  kind: publicDecisionKindSchema,
  status: z.enum(['pending', 'approved', 'rejected', 'expired']),
  presentation: publicDecisionPresentationSchema,
  requestedAt: publicProjectionCanonicalTimestampSchema,
  resolvedAt: publicProjectionCanonicalTimestampSchema.optional(),
  action: publicDecisionActionSchema.optional()
}).strict().superRefine((value, context) => {
  if (value.presentation.kind !== value.kind) {
    context.addIssue({
      code: 'custom',
      path: ['presentation', 'kind'],
      message: 'Decision presentation kind must match the Decision kind.'
    });
  }
  if (
    value.resolvedAt !== undefined
    && Date.parse(value.resolvedAt) < Date.parse(value.requestedAt)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['resolvedAt'],
      message: 'resolvedAt cannot precede requestedAt.'
    });
  }
  if (value.status === 'pending' && value.resolvedAt !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['resolvedAt'],
      message: 'A pending decision cannot have resolvedAt.'
    });
  }
  if (value.status !== 'pending' && value.resolvedAt === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['resolvedAt'],
      message: 'A terminal decision requires resolvedAt.'
    });
  }
  if (value.status === 'pending' && value.action === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['action'],
      message: 'A pending decision requires an opaque action descriptor.'
    });
  }
  if (value.status !== 'pending' && value.action !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['action'],
      message: 'A terminal decision cannot remain actionable.'
    });
  }
  if (value.action !== undefined) {
    const allowed: readonly PublicDecisionChoice[] = publicDecisionChoicesByKind[value.kind];
    const allowedSet = new Set<PublicDecisionChoice>(allowed);
    const choices = value.action.choices;
    const valid = value.kind === 'recovery'
      ? choices.every((choice) => allowedSet.has(choice))
      : choices.length === allowed.length
        && choices.every((choice, index) => choice === allowed[index]);
    if (!valid) {
      context.addIssue({
        code: 'custom',
        path: ['action', 'choices'],
        message: 'Decision action choices do not match the decision kind.'
      });
    }
  }
});
export type PublicDecisionProjection = z.infer<typeof publicDecisionProjectionSchema>;

export const publicModelProjectionSchema = z.object({
  modelId: publicProjectionCanonicalIdSchema,
  version: versionSchema,
  label: boundedLabelSchema,
  location: z.enum(['local', 'remote']),
  enabled: z.boolean().optional(),
  availability: z.enum(['ready', 'unavailable', 'checking', 'error']),
  supportsTextChat: z.boolean(),
  supportsAgent: z.boolean(),
  supportsPlan: z.boolean(),
  supportsVision: z.boolean(),
  qualificationState: z.enum(['unknown', 'testing', 'qualified', 'rejected']),
  quality: modelQualitySummarySchema.optional(),
  updatedAt: publicProjectionCanonicalTimestampSchema
}).strict();
export type PublicModelProjection = z.infer<typeof publicModelProjectionSchema>;

export const publicDiagnosticProjectionSchema = z.object({
  diagnosticId: publicProjectionCanonicalIdSchema,
  version: versionSchema,
  severity: z.enum(['info', 'warning', 'error']),
  code: z.string().trim().min(1).max(128).regex(/^[A-Z0-9_]+$/u),
  message: z.string().max(8_192),
  observedAt: publicProjectionCanonicalTimestampSchema
}).strict();
export type PublicDiagnosticProjection = z.infer<
  typeof publicDiagnosticProjectionSchema
>;

export const publicInferenceChunkProjectionSchema = z.object({
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  channel: z.enum(['token', 'reasoning']),
  text: z.string().min(1).max(32 * 1_024).superRefine((value, context) => {
    if (new TextEncoder().encode(value).byteLength > 32 * 1_024) {
      context.addIssue({ code: 'custom', message: 'Inference chunk exceeds 32768 UTF-8 bytes.' });
    }
  }),
  observedAt: publicProjectionCanonicalTimestampSchema
}).strict();
export type PublicInferenceChunkProjection = z.infer<
  typeof publicInferenceChunkProjectionSchema
>;

export const publicInferenceStreamProjectionSchema = z.object({
  inferenceStreamId: publicProjectionCanonicalIdSchema,
  sessionId: publicProjectionCanonicalIdSchema,
  runId: publicProjectionCanonicalIdSchema,
  turnId: publicProjectionCanonicalIdSchema,
  attemptId: publicProjectionCanonicalIdSchema,
  version: versionSchema,
  status: z.enum(['streaming', 'committed', 'interrupted']),
  retainedFromSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  finalSequence: cursorSchema,
  chunks: z.array(publicInferenceChunkProjectionSchema).max(1_024),
  updatedAt: publicProjectionCanonicalTimestampSchema
}).strict().superRefine((value, context) => {
  let expected = value.retainedFromSequence;
  let retainedBytes = 0;
  for (let index = 0; index < value.chunks.length; index += 1) {
    const chunk = value.chunks[index]!;
    if (chunk.sequence !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['chunks', index, 'sequence'],
        message: 'Retained inference chunks must be strictly contiguous.'
      });
    }
    expected += 1;
    retainedBytes += new TextEncoder().encode(chunk.text).byteLength;
  }
  if (retainedBytes > 256 * 1_024) {
    context.addIssue({
      code: 'custom',
      path: ['chunks'],
      message: 'Retained inference stream text exceeds 262144 UTF-8 bytes.'
    });
  }
  const expectedFinal = value.chunks.at(-1)?.sequence ?? value.retainedFromSequence - 1;
  if (value.finalSequence !== expectedFinal) {
    context.addIssue({
      code: 'custom',
      path: ['finalSequence'],
      message: 'finalSequence must equal the last retained chunk sequence.'
    });
  }
});
export type PublicInferenceStreamProjection = z.infer<
  typeof publicInferenceStreamProjectionSchema
>;

export const publicProjectionFeatureSchema = z.enum([
  'sessions',
  'messages',
  'runs',
  'decisions',
  'models',
  'diagnostics',
  'inference_streams'
]);
export type PublicProjectionFeature = z.infer<typeof publicProjectionFeatureSchema>;

/**
 * Carries the version of a deleted aggregate across a full Snapshot boundary.
 * Without this head metadata a client that starts after a delete would treat a
 * later re-creation as version 1 and reject the real next version as a gap.
 */
export const publicProjectionTombstoneSchema = z.object({
  feature: publicProjectionFeatureSchema,
  aggregateId: publicProjectionCanonicalIdSchema,
  aggregateVersion: versionSchema,
  projectedAt: publicProjectionCanonicalTimestampSchema
}).strict();
export type PublicProjectionTombstone = z.infer<
  typeof publicProjectionTombstoneSchema
>;

const projectionChangeFields = {
  operation: z.enum(['upsert', 'delete']),
  aggregateId: publicProjectionCanonicalIdSchema,
  aggregateVersion: versionSchema,
  projectedAt: publicProjectionCanonicalTimestampSchema
} as const;

interface ProjectionChangeIdentityInput {
  readonly operation: 'upsert' | 'delete';
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly dto: unknown;
}

function changeIdentityIssues(
  value: ProjectionChangeIdentityInput,
  idField: string
): ReadonlyArray<{ readonly path: readonly string[]; readonly message: string }> {
  if (value.operation === 'delete') {
    return value.dto === null
      ? []
      : [{ path: ['dto'], message: 'A delete change must have a null DTO.' }];
  }
  if (value.dto === null || typeof value.dto !== 'object') {
    return [{ path: ['dto'], message: 'An upsert change requires a DTO.' }];
  }
  const dto = value.dto as Record<string, unknown>;
  const issues: Array<{ readonly path: readonly string[]; readonly message: string }> = [];
  if (dto[idField] !== value.aggregateId) {
    issues.push({
      path: ['dto', idField],
      message: 'DTO identity must match aggregateId.'
    });
  }
  if (dto.version !== value.aggregateVersion) {
    issues.push({
      path: ['dto', 'version'],
      message: 'DTO version must match aggregateVersion.'
    });
  }
  return issues;
}

const publicSessionProjectionChangeSchema = z.object({
  feature: z.literal('sessions'),
  ...projectionChangeFields,
  dto: publicSessionProjectionSchema.nullable()
}).strict().superRefine((value, context) => {
  for (const issue of changeIdentityIssues(value, 'sessionId')) {
    context.addIssue({ code: 'custom', path: [...issue.path], message: issue.message });
  }
});

const publicMessageProjectionChangeSchema = z.object({
  feature: z.literal('messages'),
  ...projectionChangeFields,
  dto: publicMessageProjectionSchema.nullable()
}).strict().superRefine((value, context) => {
  for (const issue of changeIdentityIssues(value, 'messageId')) {
    context.addIssue({ code: 'custom', path: [...issue.path], message: issue.message });
  }
});

const publicRunProjectionChangeSchema = z.object({
  feature: z.literal('runs'),
  ...projectionChangeFields,
  dto: publicRunProjectionSchema.nullable()
}).strict().superRefine((value, context) => {
  for (const issue of changeIdentityIssues(value, 'runId')) {
    context.addIssue({ code: 'custom', path: [...issue.path], message: issue.message });
  }
});

const publicDecisionProjectionChangeSchema = z.object({
  feature: z.literal('decisions'),
  ...projectionChangeFields,
  dto: publicDecisionProjectionSchema.nullable()
}).strict().superRefine((value, context) => {
  for (const issue of changeIdentityIssues(value, 'decisionId')) {
    context.addIssue({ code: 'custom', path: [...issue.path], message: issue.message });
  }
});

const publicModelProjectionChangeSchema = z.object({
  feature: z.literal('models'),
  ...projectionChangeFields,
  dto: publicModelProjectionSchema.nullable()
}).strict().superRefine((value, context) => {
  for (const issue of changeIdentityIssues(value, 'modelId')) {
    context.addIssue({ code: 'custom', path: [...issue.path], message: issue.message });
  }
});

const publicDiagnosticProjectionChangeSchema = z.object({
  feature: z.literal('diagnostics'),
  ...projectionChangeFields,
  dto: publicDiagnosticProjectionSchema.nullable()
}).strict().superRefine((value, context) => {
  for (const issue of changeIdentityIssues(value, 'diagnosticId')) {
    context.addIssue({ code: 'custom', path: [...issue.path], message: issue.message });
  }
});

const publicInferenceStreamProjectionChangeSchema = z.object({
  feature: z.literal('inference_streams'),
  ...projectionChangeFields,
  dto: publicInferenceStreamProjectionSchema.nullable()
}).strict().superRefine((value, context) => {
  for (const issue of changeIdentityIssues(value, 'inferenceStreamId')) {
    context.addIssue({ code: 'custom', path: [...issue.path], message: issue.message });
  }
});

export const publicProjectionChangeSchema = z.union([
  publicSessionProjectionChangeSchema,
  publicMessageProjectionChangeSchema,
  publicRunProjectionChangeSchema,
  publicDecisionProjectionChangeSchema,
  publicModelProjectionChangeSchema,
  publicDiagnosticProjectionChangeSchema,
  publicInferenceStreamProjectionChangeSchema
]);
export type PublicProjectionChange = z.infer<typeof publicProjectionChangeSchema>;

export const projectionCommitSchema = z.object({
  contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
  eventId: publicProjectionCanonicalIdSchema,
  sourceId: publicProjectionCanonicalIdSchema,
  sourceCursor: versionSchema,
  occurredAt: publicProjectionCanonicalTimestampSchema,
  changes: z.array(publicProjectionChangeSchema).min(1).max(256)
}).strict();
export type ProjectionCommit = z.infer<typeof projectionCommitSchema>;

export const publicProjectionSnapshotSchema = z.object({
  contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
  streamId: publicProjectionCanonicalIdSchema,
  cursor: cursorSchema,
  cursorDigest: publicProjectionDigestSchema,
  capturedAt: publicProjectionCanonicalTimestampSchema,
  sessions: z.array(publicSessionProjectionSchema).max(20_000),
  messages: z.array(publicMessageProjectionSchema).max(100_000),
  runs: z.array(publicRunProjectionSchema).max(20_000),
  decisions: z.array(publicDecisionProjectionSchema).max(20_000),
  models: z.array(publicModelProjectionSchema).max(10_000),
  diagnostics: z.array(publicDiagnosticProjectionSchema).max(20_000),
  inferenceStreams: z.array(publicInferenceStreamProjectionSchema).max(20_000),
  tombstones: z.array(publicProjectionTombstoneSchema).max(190_000)
}).strict().superRefine((value, context) => {
  if (
    (value.cursor === 0 && value.cursorDigest !== PUBLIC_PROJECTION_GENESIS_DIGEST)
    || (value.cursor > 0 && value.cursorDigest === PUBLIC_PROJECTION_GENESIS_DIGEST)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['cursorDigest'],
      message: 'cursorDigest must identify the exact cursor history.'
    });
  }
});
export type PublicProjectionSnapshot = z.infer<typeof publicProjectionSnapshotSchema>;

export const publicProjectionCursorCommitSchema = z.object({
  cursor: versionSchema,
  cursorDigest: publicProjectionDigestSchema.refine(
    (value) => value !== PUBLIC_PROJECTION_GENESIS_DIGEST,
    'A committed cursor cannot use the genesis digest.'
  ),
  commit: projectionCommitSchema
}).strict();
export type PublicProjectionCursorCommit = z.infer<
  typeof publicProjectionCursorCommitSchema
>;

export const publicProjectionReadRequestSchema = z.object({
  contractVersion: z.string().trim().min(1).max(32),
  streamId: publicProjectionCanonicalIdSchema,
  afterCursor: cursorSchema,
  afterDigest: publicProjectionDigestSchema,
  limit: z.number().int().min(1).max(2_000)
}).strict().superRefine((value, context) => {
  if (
    (value.afterCursor === 0 && value.afterDigest !== PUBLIC_PROJECTION_GENESIS_DIGEST)
    || (value.afterCursor > 0 && value.afterDigest === PUBLIC_PROJECTION_GENESIS_DIGEST)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['afterDigest'],
      message: 'afterDigest must identify afterCursor.'
    });
  }
});
export type PublicProjectionReadRequest = z.infer<
  typeof publicProjectionReadRequestSchema
>;

export const publicProjectionReadBatchSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    streamId: publicProjectionCanonicalIdSchema,
    afterCursor: cursorSchema,
    afterDigest: publicProjectionDigestSchema,
    nextCursor: cursorSchema,
    nextDigest: publicProjectionDigestSchema,
    hasMore: z.boolean(),
    commits: z.array(publicProjectionCursorCommitSchema).max(2_000)
  }).strict(),
  z.object({
    status: z.literal('reset_required'),
    contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    streamId: publicProjectionCanonicalIdSchema,
    currentCursor: cursorSchema,
    reason: z.enum([
      'stream_mismatch',
      'contract_mismatch',
      'cursor_gap',
      'history_mismatch'
    ])
  }).strict()
]).superRefine((value, context) => {
  if (value.status !== 'ok') return;
  if (
    (value.afterCursor === 0 && value.afterDigest !== PUBLIC_PROJECTION_GENESIS_DIGEST)
    || (value.afterCursor > 0 && value.afterDigest === PUBLIC_PROJECTION_GENESIS_DIGEST)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['afterDigest'],
      message: 'afterDigest must identify afterCursor.'
    });
  }
  let expectedCursor = value.afterCursor + 1;
  for (let index = 0; index < value.commits.length; index += 1) {
    const cursorCommit = value.commits[index]!;
    if (cursorCommit.cursor !== expectedCursor) {
      context.addIssue({
        code: 'custom',
        path: ['commits', index, 'cursor'],
        message: 'Projection cursors must be strictly contiguous.'
      });
    }
    expectedCursor += 1;
  }
  const last = value.commits.at(-1);
  const expectedNextCursor = last?.cursor ?? value.afterCursor;
  const expectedNextDigest = last?.cursorDigest ?? value.afterDigest;
  if (value.nextCursor !== expectedNextCursor) {
    context.addIssue({
      code: 'custom',
      path: ['nextCursor'],
      message: 'nextCursor must equal the last returned cursor.'
    });
  }
  if (value.nextDigest !== expectedNextDigest) {
    context.addIssue({
      code: 'custom',
      path: ['nextDigest'],
      message: 'nextDigest must equal the last returned cursor digest.'
    });
  }
  if (value.hasMore && value.commits.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['hasMore'],
      message: 'A non-terminal batch must make cursor progress.'
    });
  }
});
export type PublicProjectionReadBatch = z.infer<
  typeof publicProjectionReadBatchSchema
>;

export const MAX_PUBLIC_PROJECTION_COMMIT_BYTES = 1024 * 1024;
export const MAX_PUBLIC_PROJECTION_SNAPSHOT_BYTES = 8 * 1024 * 1024;
export const MAX_PUBLIC_PROJECTION_READ_BATCH_BYTES = 8 * 1024 * 1024;

const forbiddenPayloadKey = /^(?:absolute_?path|path|cwd|command|args|arguments|api_?key|access_?token|secret|password|authorization|provider_?input|raw_?input|tool_?input|prompt)$/iu;
const fileAbsoluteUri = /\bfile:(?:\/{2,3}|\\{2})/iu;
const windowsAbsolutePath = /(?:^|[^A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\[^\s\\/]+[\\/])/u;
const posixAbsolutePath = /(?:^|[\s("'`=\[<{:,;])\/(?!\/)[^\s"'`)\]}>]+/u;
const credentialValue = /(?:\b(?:api[_ -]?key|access[_ -]?token|secret|password|authorization)\b["']?\s*[:=]\s*["']?\s*[^\s"',}\]]+|\bBearer\s+[A-Za-z0-9._~+\/-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}|\b(?:ghp|github_pat)_[A-Za-z0-9_-]{12,}|\bAKIA[A-Z0-9]{16}\b)/iu;

const fileAbsoluteUriGlobal = /\bfile:(?:\/{2,3}|\\{2})/giu;
const windowsAbsolutePathGlobal = /(?:^|[^A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\[^\s\\/]+[\\/])/gu;
const posixAbsolutePathGlobal = /(?:^|[\s("'`=\[<{:,;])\/(?!\/)[^\s"'`)\]}>]+/gu;
const credentialValueGlobal = /(?:\b(?:api[_ -]?key|access[_ -]?token|secret|password|authorization)\b["']?\s*[:=]\s*["']?\s*[^\s"',}\]]+|\bBearer\s+[A-Za-z0-9._~+\/-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}|\b(?:ghp|github_pat)_[A-Za-z0-9_-]{12,}|\bAKIA[A-Z0-9]{16}\b)/giu;

/**
 * Deterministic redaction for intentionally user-visible text fields. The
 * structured projection validator still fails closed if a producer forgets
 * to call this function or places private data in any other field.
 */
export function redactPublicProjectionText(value: string): string {
  if (typeof value !== 'string') {
    throw new Error('public_projection_redaction_input_invalid');
  }
  return value
    .replace(fileAbsoluteUriGlobal, '[redacted file URI]')
    .replace(windowsAbsolutePathGlobal, ' [redacted path]')
    .replace(posixAbsolutePathGlobal, ' [redacted path]')
    .replace(credentialValueGlobal, '[redacted credential]');
}

export function assertPublicProjectionCommit(value: unknown): ProjectionCommit {
  const commit = projectionCommitSchema.parse(value);
  assertBoundedCanonicalJson(
    commit,
    MAX_PUBLIC_PROJECTION_COMMIT_BYTES,
    'public_projection_commit'
  );
  assertPublicProjectionPayloadSafe(commit);
  return commit;
}

export function assertPublicProjectionSnapshot(
  value: unknown
): PublicProjectionSnapshot {
  const snapshot = publicProjectionSnapshotSchema.parse(value);
  assertBoundedCanonicalJson(
    snapshot,
    MAX_PUBLIC_PROJECTION_SNAPSHOT_BYTES,
    'public_projection_snapshot'
  );
  assertPublicProjectionPayloadSafe(snapshot);
  assertSortedUnique(snapshot.sessions, (entry) => entry.sessionId, 'sessions');
  assertSortedUnique(snapshot.messages, (entry) => entry.messageId, 'messages');
  assertSortedUnique(snapshot.runs, (entry) => entry.runId, 'runs');
  assertSortedUnique(snapshot.decisions, (entry) => entry.decisionId, 'decisions');
  assertSortedUnique(snapshot.models, (entry) => entry.modelId, 'models');
  assertSortedUnique(
    snapshot.diagnostics,
    (entry) => entry.diagnosticId,
    'diagnostics'
  );
  assertSortedUnique(
    snapshot.inferenceStreams,
    (entry) => entry.inferenceStreamId,
    'inference_streams'
  );
  assertSortedUnique(
    snapshot.tombstones,
    (entry) => `${entry.feature}\u0000${entry.aggregateId}`,
    'tombstones'
  );
  assertSnapshotTombstonesDoNotOverlapVisibleRows(snapshot);
  return snapshot;
}

export function assertPublicProjectionReadBatch(
  value: unknown
): PublicProjectionReadBatch {
  const batch = publicProjectionReadBatchSchema.parse(value);
  assertBoundedCanonicalJson(
    batch,
    MAX_PUBLIC_PROJECTION_READ_BATCH_BYTES,
    'public_projection_read_batch'
  );
  assertPublicProjectionPayloadSafe(batch);
  if (batch.status === 'ok') {
    for (const entry of batch.commits) {
      assertPublicProjectionCommit(entry.commit);
    }
  }
  return batch;
}

export function assertPublicProjectionReadRequest(
  value: unknown
): PublicProjectionReadRequest {
  return publicProjectionReadRequestSchema.parse(value);
}

export function assertPublicProjectionPayloadSafe(value: unknown): void {
  visitPublicPayload(value, '$');
}

export function canonicalPublicProjectionJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('public_projection_json_number_invalid');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalPublicProjectionJson).join(',')}]`;
  }
  if (!isPlainObject(value)) throw new Error('public_projection_json_value_invalid');
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalPublicProjectionJson(value[key])}`
  )).join(',')}}`;
}

function visitPublicPayload(value: unknown, location: string): void {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return;
  if (typeof value === 'string') {
    if (
      fileAbsoluteUri.test(value)
      || windowsAbsolutePath.test(value)
      || posixAbsolutePath.test(value)
    ) {
      throw new Error(`public_projection_absolute_path_forbidden:${location}`);
    }
    if (credentialValue.test(value)) {
      throw new Error(`public_projection_secret_forbidden:${location}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => (
      visitPublicPayload(entry, `${location}[${String(index)}]`)
    ));
    return;
  }
  if (!isPlainObject(value)) throw new Error(`public_projection_value_invalid:${location}`);
  for (const [key, entry] of Object.entries(value)) {
    if (forbiddenPayloadKey.test(key)) {
      throw new Error(`public_projection_private_field_forbidden:${location}.${key}`);
    }
    visitPublicPayload(entry, `${location}.${key}`);
  }
}

function assertBoundedCanonicalJson(
  value: unknown,
  maxBytes: number,
  label: string
): void {
  const serialized = canonicalPublicProjectionJson(value);
  const size = new TextEncoder().encode(serialized).byteLength;
  if (size > maxBytes) throw new Error(`${label}_too_large:${String(size)}:${String(maxBytes)}`);
}

function assertSortedUnique<T>(
  values: readonly T[],
  identify: (entry: T) => string,
  feature: string
): void {
  let previous: string | null = null;
  for (const value of values) {
    const current = identify(value);
    if (previous !== null && current <= previous) {
      throw new Error(`public_projection_snapshot_order_invalid:${feature}`);
    }
    previous = current;
  }
}

function assertSnapshotTombstonesDoNotOverlapVisibleRows(
  snapshot: PublicProjectionSnapshot
): void {
  const visible = new Set<string>([
    ...snapshot.sessions.map((entry) => `sessions\u0000${entry.sessionId}`),
    ...snapshot.messages.map((entry) => `messages\u0000${entry.messageId}`),
    ...snapshot.runs.map((entry) => `runs\u0000${entry.runId}`),
    ...snapshot.decisions.map((entry) => `decisions\u0000${entry.decisionId}`),
    ...snapshot.models.map((entry) => `models\u0000${entry.modelId}`),
    ...snapshot.diagnostics.map((entry) => `diagnostics\u0000${entry.diagnosticId}`),
    ...snapshot.inferenceStreams.map(
      (entry) => `inference_streams\u0000${entry.inferenceStreamId}`
    )
  ]);
  for (const tombstone of snapshot.tombstones) {
    const identity = `${tombstone.feature}\u0000${tombstone.aggregateId}`;
    if (visible.has(identity)) {
      throw new Error(`public_projection_snapshot_head_overlap:${tombstone.feature}`);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

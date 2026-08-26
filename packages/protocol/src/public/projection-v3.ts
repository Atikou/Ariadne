import { z } from 'zod';

export const PUBLIC_PROJECTION_CONTRACT_VERSION = '3.0' as const;

export const publicProjectionCanonicalIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const publicProjectionCanonicalTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => (
    Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value
  ), 'Timestamp must be canonical UTC with millisecond precision.');

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

export const publicSessionProjectionV3Schema = z.object({
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
export type PublicSessionProjectionV3 = z.infer<typeof publicSessionProjectionV3Schema>;

export const publicMessageProjectionV3Schema = z.object({
  messageId: publicProjectionCanonicalIdSchema,
  sessionId: publicProjectionCanonicalIdSchema,
  runId: publicProjectionCanonicalIdSchema.optional(),
  version: versionSchema,
  role: z.enum(['user', 'assistant', 'system']),
  content: boundedTextSchema,
  status: z.enum(['streaming', 'completed', 'interrupted', 'failed']),
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
export type PublicMessageProjectionV3 = z.infer<typeof publicMessageProjectionV3Schema>;

export const publicToolActivityProjectionV3Schema = z.object({
  activityId: publicProjectionCanonicalIdSchema,
  callId: publicProjectionCanonicalIdSchema,
  toolName: publicProjectionCanonicalIdSchema,
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  occurredAt: publicProjectionCanonicalTimestampSchema,
  startedAt: publicProjectionCanonicalTimestampSchema.optional(),
  completedAt: publicProjectionCanonicalTimestampSchema.optional()
}).strict();
export type PublicToolActivityProjectionV3 = z.infer<
  typeof publicToolActivityProjectionV3Schema
>;

export const publicAgentInboxInputV3Schema = z.object({
  inputId: publicProjectionCanonicalIdSchema,
  messageId: publicProjectionCanonicalIdSchema,
  version: versionSchema,
  delivery: z.enum(['next_turn', 'next_step']),
  content: boundedTextSchema,
  state: z.enum(['queued', 'claimed']),
  queuedAt: publicProjectionCanonicalTimestampSchema,
  updatedAt: publicProjectionCanonicalTimestampSchema,
  claimedTurnId: publicProjectionCanonicalIdSchema.optional()
}).strict();
export type PublicAgentInboxInputV3 = z.infer<typeof publicAgentInboxInputV3Schema>;

export const publicRunProjectionV3Schema = z.object({
  runId: publicProjectionCanonicalIdSchema,
  sessionId: publicProjectionCanonicalIdSchema.optional(),
  sourceMessageId: publicProjectionCanonicalIdSchema.optional(),
  parentRunId: publicProjectionCanonicalIdSchema.optional(),
  delegationId: publicProjectionCanonicalIdSchema.optional(),
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
  progress: z.number().min(0).max(1).optional(),
  toolActivities: z.array(publicToolActivityProjectionV3Schema).max(1_000).default([]),
  inbox: z.array(publicAgentInboxInputV3Schema).max(1_000).default([]),
  interactionMessages: z.array(publicMessageProjectionV3Schema).max(1_000).default([]),
  updatedAt: publicProjectionCanonicalTimestampSchema,
  startedAt: publicProjectionCanonicalTimestampSchema.optional(),
  completedAt: publicProjectionCanonicalTimestampSchema.optional()
}).strict().superRefine((value, context) => {
  if ((value.parentRunId === undefined) !== (value.delegationId === undefined)) {
    context.addIssue({
      code: 'custom',
      path: ['parentRunId'],
      message: 'parentRunId and delegationId must appear together.'
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
export type PublicRunProjectionV3 = z.infer<typeof publicRunProjectionV3Schema>;

export const PUBLIC_DECISION_ACTION_CONTRACT_VERSION = '1.0' as const;

export const publicDecisionChoiceV3Schema = z.enum([
  'allow_once',
  'allow_run',
  'deny',
  'approve',
  'reject',
  'retry',
  'mark_succeeded',
  'mark_failed',
  'cancel_run',
  'resume'
]);
export type PublicDecisionChoiceV3 = z.infer<typeof publicDecisionChoiceV3Schema>;

export const publicDecisionActionTokenV1Schema = publicProjectionCanonicalIdSchema.regex(
  /^decision-action\.v1:[0-9a-f]{64}$/u
);

export const publicDecisionActionV3Schema = z.object({
  contractVersion: z.literal(PUBLIC_DECISION_ACTION_CONTRACT_VERSION),
  actionToken: publicDecisionActionTokenV1Schema,
  choices: z.array(publicDecisionChoiceV3Schema).min(1).max(4)
}).strict().superRefine((value, context) => {
  if (new Set(value.choices).size !== value.choices.length) {
    context.addIssue({
      code: 'custom',
      path: ['choices'],
      message: 'Decision action choices must be unique.'
    });
  }
});
export type PublicDecisionActionV3 = z.infer<typeof publicDecisionActionV3Schema>;

const publicDecisionKindV3Schema = z.enum([
  'permission',
  'plan',
  'recovery',
  'budget'
]);

const publicDecisionChoicesByKind = {
  permission: ['allow_once', 'allow_run', 'deny'],
  plan: ['approve', 'reject'],
  recovery: ['retry', 'mark_succeeded', 'mark_failed', 'cancel_run'],
  budget: ['resume', 'cancel_run']
} as const satisfies Record<
  z.infer<typeof publicDecisionKindV3Schema>,
  readonly PublicDecisionChoiceV3[]
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

export const publicPlanStepImpactV1Schema = z.enum([
  'read_only',
  'workspace_change',
  'command_execution',
  'network_access',
  'external_side_effect',
  'mixed'
]);
export type PublicPlanStepImpactV1 = z.infer<typeof publicPlanStepImpactV1Schema>;

/**
 * The only Plan payload fragment that a public projector may consume.
 * Protected Plan payloads may contain additional private execution data, but
 * it can never be copied or inferred into this strict, explicitly public DTO.
 */
export const publicPlanDecisionPresentationSourceV1Schema = z.object({
  contractVersion: z.literal(PUBLIC_DECISION_PRESENTATION_CONTRACT_VERSION),
  summary: publicDecisionSummarySchema,
  impactSummary: publicDecisionSummarySchema,
  steps: z.array(z.object({
    title: z.string().trim().min(1).max(256),
    summary: z.string().trim().min(1).max(1_024),
    impact: publicPlanStepImpactV1Schema
  }).strict()).min(1).max(32)
}).strict();
export type PublicPlanDecisionPresentationSourceV1 = z.infer<
  typeof publicPlanDecisionPresentationSourceV1Schema
>;

export const publicPermissionDecisionPresentationV1Schema = z.object({
  contractVersion: z.literal(PUBLIC_DECISION_PRESENTATION_CONTRACT_VERSION),
  kind: z.literal('permission'),
  headline: publicDecisionHeadlineSchema,
  summary: publicDecisionSummarySchema,
  toolName: publicProjectionCanonicalIdSchema,
  capabilityIds: publicDecisionIdentifierListSchema(1),
  scopeIds: publicDecisionIdentifierListSchema(0),
  resourceSummary: publicDecisionSummarySchema
}).strict();

export const publicPlanDecisionPresentationV1Schema = z.object({
  contractVersion: z.literal(PUBLIC_DECISION_PRESENTATION_CONTRACT_VERSION),
  kind: z.literal('plan'),
  headline: publicDecisionHeadlineSchema,
  summary: publicDecisionSummarySchema,
  impactSummary: publicDecisionSummarySchema,
  approvalScope: z.literal('continue_run_with_presented_plan'),
  steps: publicPlanDecisionPresentationSourceV1Schema.shape.steps
}).strict();

const publicRecoveryDecisionPresentationV1Schema = z.object({
  contractVersion: z.literal(PUBLIC_DECISION_PRESENTATION_CONTRACT_VERSION),
  kind: z.literal('recovery'),
  headline: publicDecisionHeadlineSchema,
  summary: publicDecisionSummarySchema
}).strict();

const publicBudgetDecisionPresentationV1Schema = z.object({
  contractVersion: z.literal(PUBLIC_DECISION_PRESENTATION_CONTRACT_VERSION),
  kind: z.literal('budget'),
  headline: publicDecisionHeadlineSchema,
  summary: publicDecisionSummarySchema
}).strict();

export const publicDecisionPresentationV1Schema = z.discriminatedUnion('kind', [
  publicPermissionDecisionPresentationV1Schema,
  publicPlanDecisionPresentationV1Schema,
  publicRecoveryDecisionPresentationV1Schema,
  publicBudgetDecisionPresentationV1Schema
]);
export type PublicDecisionPresentationV1 = z.infer<
  typeof publicDecisionPresentationV1Schema
>;

export const publicDecisionProjectionV3Schema = z.object({
  decisionId: publicProjectionCanonicalIdSchema,
  runId: publicProjectionCanonicalIdSchema,
  sessionId: publicProjectionCanonicalIdSchema,
  version: versionSchema,
  kind: publicDecisionKindV3Schema,
  status: z.enum(['pending', 'approved', 'rejected', 'expired']),
  presentation: publicDecisionPresentationV1Schema,
  requestedAt: publicProjectionCanonicalTimestampSchema,
  resolvedAt: publicProjectionCanonicalTimestampSchema.optional(),
  action: publicDecisionActionV3Schema.optional()
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
    const allowed: readonly PublicDecisionChoiceV3[] = publicDecisionChoicesByKind[value.kind];
    const allowedSet = new Set<PublicDecisionChoiceV3>(allowed);
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
export type PublicDecisionProjectionV3 = z.infer<typeof publicDecisionProjectionV3Schema>;

export const publicModelProjectionV3Schema = z.object({
  modelId: publicProjectionCanonicalIdSchema,
  version: versionSchema,
  label: boundedLabelSchema,
  location: z.enum(['local', 'remote']),
  availability: z.enum(['ready', 'unavailable', 'checking', 'error']),
  supportsAgent: z.boolean(),
  supportsVision: z.boolean(),
  updatedAt: publicProjectionCanonicalTimestampSchema
}).strict();
export type PublicModelProjectionV3 = z.infer<typeof publicModelProjectionV3Schema>;

export const publicDiagnosticProjectionV3Schema = z.object({
  diagnosticId: publicProjectionCanonicalIdSchema,
  version: versionSchema,
  severity: z.enum(['info', 'warning', 'error']),
  code: z.string().trim().min(1).max(128).regex(/^[A-Z0-9_]+$/u),
  message: z.string().max(8_192),
  observedAt: publicProjectionCanonicalTimestampSchema
}).strict();
export type PublicDiagnosticProjectionV3 = z.infer<
  typeof publicDiagnosticProjectionV3Schema
>;

export const publicProjectionFeatureV3Schema = z.enum([
  'sessions',
  'messages',
  'runs',
  'decisions',
  'models',
  'diagnostics'
]);
export type PublicProjectionFeatureV3 = z.infer<typeof publicProjectionFeatureV3Schema>;

/**
 * Carries the version of a deleted aggregate across a full Snapshot boundary.
 * Without this head metadata a client that starts after a delete would treat a
 * later re-creation as version 1 and reject the real next version as a gap.
 */
export const publicProjectionTombstoneV3Schema = z.object({
  feature: publicProjectionFeatureV3Schema,
  aggregateId: publicProjectionCanonicalIdSchema,
  aggregateVersion: versionSchema,
  projectedAt: publicProjectionCanonicalTimestampSchema
}).strict();
export type PublicProjectionTombstoneV3 = z.infer<
  typeof publicProjectionTombstoneV3Schema
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

const publicSessionProjectionChangeV3Schema = z.object({
  feature: z.literal('sessions'),
  ...projectionChangeFields,
  dto: publicSessionProjectionV3Schema.nullable()
}).strict().superRefine((value, context) => {
  for (const issue of changeIdentityIssues(value, 'sessionId')) {
    context.addIssue({ code: 'custom', path: [...issue.path], message: issue.message });
  }
});

const publicMessageProjectionChangeV3Schema = z.object({
  feature: z.literal('messages'),
  ...projectionChangeFields,
  dto: publicMessageProjectionV3Schema.nullable()
}).strict().superRefine((value, context) => {
  for (const issue of changeIdentityIssues(value, 'messageId')) {
    context.addIssue({ code: 'custom', path: [...issue.path], message: issue.message });
  }
});

const publicRunProjectionChangeV3Schema = z.object({
  feature: z.literal('runs'),
  ...projectionChangeFields,
  dto: publicRunProjectionV3Schema.nullable()
}).strict().superRefine((value, context) => {
  for (const issue of changeIdentityIssues(value, 'runId')) {
    context.addIssue({ code: 'custom', path: [...issue.path], message: issue.message });
  }
});

const publicDecisionProjectionChangeV3Schema = z.object({
  feature: z.literal('decisions'),
  ...projectionChangeFields,
  dto: publicDecisionProjectionV3Schema.nullable()
}).strict().superRefine((value, context) => {
  for (const issue of changeIdentityIssues(value, 'decisionId')) {
    context.addIssue({ code: 'custom', path: [...issue.path], message: issue.message });
  }
});

const publicModelProjectionChangeV3Schema = z.object({
  feature: z.literal('models'),
  ...projectionChangeFields,
  dto: publicModelProjectionV3Schema.nullable()
}).strict().superRefine((value, context) => {
  for (const issue of changeIdentityIssues(value, 'modelId')) {
    context.addIssue({ code: 'custom', path: [...issue.path], message: issue.message });
  }
});

const publicDiagnosticProjectionChangeV3Schema = z.object({
  feature: z.literal('diagnostics'),
  ...projectionChangeFields,
  dto: publicDiagnosticProjectionV3Schema.nullable()
}).strict().superRefine((value, context) => {
  for (const issue of changeIdentityIssues(value, 'diagnosticId')) {
    context.addIssue({ code: 'custom', path: [...issue.path], message: issue.message });
  }
});

export const publicProjectionChangeV3Schema = z.union([
  publicSessionProjectionChangeV3Schema,
  publicMessageProjectionChangeV3Schema,
  publicRunProjectionChangeV3Schema,
  publicDecisionProjectionChangeV3Schema,
  publicModelProjectionChangeV3Schema,
  publicDiagnosticProjectionChangeV3Schema
]);
export type PublicProjectionChangeV3 = z.infer<typeof publicProjectionChangeV3Schema>;

export const projectionCommitV3Schema = z.object({
  contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
  eventId: publicProjectionCanonicalIdSchema,
  sourceId: publicProjectionCanonicalIdSchema,
  sourceCursor: versionSchema,
  occurredAt: publicProjectionCanonicalTimestampSchema,
  changes: z.array(publicProjectionChangeV3Schema).min(1).max(256)
}).strict();
export type ProjectionCommitV3 = z.infer<typeof projectionCommitV3Schema>;

export const publicProjectionSnapshotV3Schema = z.object({
  contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
  streamId: publicProjectionCanonicalIdSchema,
  cursor: cursorSchema,
  cursorDigest: publicProjectionDigestSchema,
  capturedAt: publicProjectionCanonicalTimestampSchema,
  sessions: z.array(publicSessionProjectionV3Schema).max(20_000),
  messages: z.array(publicMessageProjectionV3Schema).max(100_000),
  runs: z.array(publicRunProjectionV3Schema).max(20_000),
  decisions: z.array(publicDecisionProjectionV3Schema).max(20_000),
  models: z.array(publicModelProjectionV3Schema).max(10_000),
  diagnostics: z.array(publicDiagnosticProjectionV3Schema).max(20_000),
  tombstones: z.array(publicProjectionTombstoneV3Schema).max(190_000)
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
export type PublicProjectionSnapshotV3 = z.infer<typeof publicProjectionSnapshotV3Schema>;

export const publicProjectionCursorCommitV3Schema = z.object({
  cursor: versionSchema,
  cursorDigest: publicProjectionDigestSchema.refine(
    (value) => value !== PUBLIC_PROJECTION_GENESIS_DIGEST,
    'A committed cursor cannot use the genesis digest.'
  ),
  commit: projectionCommitV3Schema
}).strict();
export type PublicProjectionCursorCommitV3 = z.infer<
  typeof publicProjectionCursorCommitV3Schema
>;

export const publicProjectionReadRequestV3Schema = z.object({
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
export type PublicProjectionReadRequestV3 = z.infer<
  typeof publicProjectionReadRequestV3Schema
>;

export const publicProjectionReadBatchV3Schema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
    streamId: publicProjectionCanonicalIdSchema,
    afterCursor: cursorSchema,
    afterDigest: publicProjectionDigestSchema,
    nextCursor: cursorSchema,
    nextDigest: publicProjectionDigestSchema,
    hasMore: z.boolean(),
    commits: z.array(publicProjectionCursorCommitV3Schema).max(2_000)
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
export type PublicProjectionReadBatchV3 = z.infer<
  typeof publicProjectionReadBatchV3Schema
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
export function redactPublicProjectionTextV3(value: string): string {
  if (typeof value !== 'string') {
    throw new Error('public_projection_redaction_input_invalid');
  }
  return value
    .replace(fileAbsoluteUriGlobal, '[redacted file URI]')
    .replace(windowsAbsolutePathGlobal, ' [redacted path]')
    .replace(posixAbsolutePathGlobal, ' [redacted path]')
    .replace(credentialValueGlobal, '[redacted credential]');
}

export function assertPublicProjectionCommitV3(value: unknown): ProjectionCommitV3 {
  const commit = projectionCommitV3Schema.parse(value);
  assertBoundedCanonicalJson(
    commit,
    MAX_PUBLIC_PROJECTION_COMMIT_BYTES,
    'public_projection_commit'
  );
  assertPublicProjectionPayloadSafeV3(commit);
  return commit;
}

export function assertPublicProjectionSnapshotV3(
  value: unknown
): PublicProjectionSnapshotV3 {
  const snapshot = publicProjectionSnapshotV3Schema.parse(value);
  assertBoundedCanonicalJson(
    snapshot,
    MAX_PUBLIC_PROJECTION_SNAPSHOT_BYTES,
    'public_projection_snapshot'
  );
  assertPublicProjectionPayloadSafeV3(snapshot);
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
    snapshot.tombstones,
    (entry) => `${entry.feature}\u0000${entry.aggregateId}`,
    'tombstones'
  );
  assertSnapshotTombstonesDoNotOverlapVisibleRows(snapshot);
  return snapshot;
}

export function assertPublicProjectionReadBatchV3(
  value: unknown
): PublicProjectionReadBatchV3 {
  const batch = publicProjectionReadBatchV3Schema.parse(value);
  assertBoundedCanonicalJson(
    batch,
    MAX_PUBLIC_PROJECTION_READ_BATCH_BYTES,
    'public_projection_read_batch'
  );
  assertPublicProjectionPayloadSafeV3(batch);
  if (batch.status === 'ok') {
    for (const entry of batch.commits) {
      assertPublicProjectionCommitV3(entry.commit);
    }
  }
  return batch;
}

export function assertPublicProjectionReadRequestV3(
  value: unknown
): PublicProjectionReadRequestV3 {
  return publicProjectionReadRequestV3Schema.parse(value);
}

export function assertPublicProjectionPayloadSafeV3(value: unknown): void {
  visitPublicPayload(value, '$');
}

export function canonicalPublicProjectionJsonV3(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('public_projection_json_number_invalid');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalPublicProjectionJsonV3).join(',')}]`;
  }
  if (!isPlainObject(value)) throw new Error('public_projection_json_value_invalid');
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalPublicProjectionJsonV3(value[key])}`
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
  const serialized = canonicalPublicProjectionJsonV3(value);
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
  snapshot: PublicProjectionSnapshotV3
): void {
  const visible = new Set<string>([
    ...snapshot.sessions.map((entry) => `sessions\u0000${entry.sessionId}`),
    ...snapshot.messages.map((entry) => `messages\u0000${entry.messageId}`),
    ...snapshot.runs.map((entry) => `runs\u0000${entry.runId}`),
    ...snapshot.decisions.map((entry) => `decisions\u0000${entry.decisionId}`),
    ...snapshot.models.map((entry) => `models\u0000${entry.modelId}`),
    ...snapshot.diagnostics.map((entry) => `diagnostics\u0000${entry.diagnosticId}`)
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

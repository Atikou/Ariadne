import type {
  AgentPlan,
  CompanionMessage,
  ConversationMessageReferenceV3,
  ImageAttachmentRefV3,
  ConversationSession,
  ModelSummary,
  PermissionRequest,
  PlanHandoff,
  PublicDecisionProjectionV3,
  PublicDiagnosticProjectionV3,
  PublicInferenceStreamProjectionV3,
  PublicMessageProjectionV3,
  PublicModelProjectionV3,
  PublicRunProjectionV3,
  PublicAgentInboxInputV3,
  PublicSessionProjectionV3,
  RunSummary,
  RunActivity,
  TraceEntry
} from '@ariadne/protocol/public';

export type RuntimeMessage = CompanionMessage & {
  deliveryState?: 'pending' | 'failed';
  attachments?: readonly ImageAttachmentRefV3[];
  reference?: ConversationMessageReferenceV3;
};

export type RuntimeRun = Omit<RunSummary, 'origin' | 'status'> & {
  /** v3 intentionally does not guess which mutation route owns this run. */
  origin: RunSummary['origin'] | 'projection';
  status: PublicRunProjectionV3['status'];
  inbox: PublicAgentInboxInputV3[];
  interactionMessages: RuntimeMessage[];
  parentRunId?: string;
  delegationId?: string;
  subagentMode?: 'one_shot' | 'continuable';
  subagentProviderId?: string;
};

export type RuntimePermissionDecision = Omit<
  PermissionRequest,
  'runId' | 'approvalVersion' | 'permissionItems' | 'status'
> & {
  runId?: string;
  projectionVersion: number;
  permissionItems: ReadonlyArray<PermissionRequest['permissionItems'][number]>;
  status: PublicDecisionProjectionV3['status'];
  toolName: string;
  scopeIds: readonly string[];
  resourceSummary: string;
  actionAvailable: boolean;
};

export type RuntimePlanDecision = Omit<
  PlanHandoff,
  'runId' | 'plan' | 'steps' | 'status'
> & {
  runId?: string;
  projectionVersion: number;
  plan: AgentPlan | null;
  steps: ReadonlyArray<PlanHandoff['steps'][number]>;
  status: PublicDecisionProjectionV3['status'];
  impactSummary: string;
  approvalScope: 'continue_run_with_presented_plan';
  actionAvailable: boolean;
};

export interface RuntimeUserQuestionDecision {
  readonly decisionId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly projectionVersion: number;
  readonly status: PublicDecisionProjectionV3['status'];
  readonly headline: string;
  readonly prompt: string;
  readonly options?: readonly {
    readonly optionId: string;
    readonly label: string;
    readonly description?: string;
  }[];
  readonly actionAvailable: boolean;
  readonly createdAt: string;
}

export function presentSession(
  session: PublicSessionProjectionV3
): ConversationSession {
  return {
    sessionId: session.sessionId,
    workspaceId: session.workspaceId,
    title: session.title,
    pinned: session.pinned,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  };
}

export function presentMessage(
  message: PublicMessageProjectionV3
): RuntimeMessage {
  return {
    messageId: message.messageId,
    sessionId: message.sessionId,
    ...(message.runId === undefined ? {} : { runId: message.runId }),
    role: message.role,
    content: message.content,
    ...(message.reference === undefined ? {} : { reference: { ...message.reference } }),
    ...(message.attachments === undefined
      ? {}
      : { attachments: message.attachments.map((attachment) => ({ ...attachment })) }),
    status: message.status,
    createdAt: message.createdAt
  };
}

export function presentInferenceStreamMessage(
  stream: PublicInferenceStreamProjectionV3,
  run: PublicRunProjectionV3 | undefined
): RuntimeMessage | null {
  if (stream.status !== 'streaming' || run?.sessionId === undefined) return null;
  const content = stream.chunks
    .filter((chunk) => chunk.channel === 'token')
    .map((chunk) => chunk.text)
    .join('');
  const reasoningContent = stream.chunks
    .filter((chunk) => chunk.channel === 'reasoning')
    .map((chunk) => chunk.text)
    .join('');
  const startedAt = stream.chunks[0]?.observedAt ?? stream.updatedAt;
  return {
    messageId: stream.inferenceStreamId,
    sessionId: run.sessionId,
    runId: stream.runId,
    role: 'assistant',
    content,
    status: 'streaming',
    createdAt: startedAt,
    ...(reasoningContent.length === 0
      ? {}
      : {
        reasoning: {
          content: reasoningContent,
          status: 'streaming',
          source: 'provider',
          startedAt
        }
      })
  };
}

export function presentRun(run: PublicRunProjectionV3): RuntimeRun {
  const activeEnd = run.completedAt ?? run.updatedAt;
  const activeDurationMs = run.startedAt === undefined
    ? 0
    : Math.max(0, Date.parse(activeEnd) - Date.parse(run.startedAt));
  const active = [
    'queued',
    'running',
    'waiting_permission',
    'waiting_decision',
    'waiting_budget',
    'waiting_children',
    'cancelling',
    'paused'
  ].includes(run.status);
  return {
    runId: run.runId,
    ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
    ...(run.sourceMessageId === undefined ? {} : { sourceMessageId: run.sourceMessageId }),
    ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
    ...(run.delegationId === undefined ? {} : { delegationId: run.delegationId }),
    ...(run.subagentMode === undefined ? {} : { subagentMode: run.subagentMode }),
    ...(run.subagentProviderId === undefined
      ? {}
      : { subagentProviderId: run.subagentProviderId }),
    origin: 'projection',
    title: run.title,
    status: run.status,
    ...(run.progress === undefined ? {} : { progress: run.progress }),
    userFacingLabel: run.label,
    aggregateVersion: run.version,
    checkpointStage: run.status,
    recoveryStatus: run.status === 'interrupted' ? 'recoverable' : 'none',
    inbox: run.inbox.map((input) => ({ ...input })),
    interactionMessages: run.interactionMessages.map(presentMessage),
    timing: {
      activeDurationMs,
      ...(active && run.startedAt !== undefined ? { activeSince: run.updatedAt } : {})
    },
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt })
  };
}

export function presentRunActivities(run: PublicRunProjectionV3): RunActivity[] {
  return run.toolActivities.map((activity, index) => ({
    activityType: 'tool',
    activityId: activity.activityId,
    runId: run.runId,
    toolCallId: activity.callId,
    toolName: activity.toolName,
    ...(activity.presentation === undefined
      ? {}
      : { presentationKind: activity.presentation.kind }),
    status: activity.status,
    title: activity.presentation?.label ?? activity.toolName,
    summary: activity.status === 'completed'
      ? '工具调用已完成'
      : activity.status === 'failed'
        ? '工具调用失败'
        : activity.status === 'running'
          ? '工具正在运行'
          : '工具等待执行',
    occurredAt: activity.occurredAt,
    ...(activity.startedAt === undefined ? {} : { startedAt: activity.startedAt }),
    ...(activity.completedAt === undefined ? {} : { completedAt: activity.completedAt }),
    ...(activity.startedAt === undefined || activity.completedAt === undefined
      ? {}
      : { durationMs: Math.max(0, Date.parse(activity.completedAt) - Date.parse(activity.startedAt)) }),
    iteration: index,
    batchId: `${run.runId}:effects`,
    laneId: 'agent-tools',
    dependsOnActivityIds: [],
    detailAvailable: false,
    changedFileCount: 0
  }));
}

export function presentPermissionDecision(
  decision: PublicDecisionProjectionV3
): RuntimePermissionDecision | null {
  if (
    decision.kind !== 'permission'
    || decision.presentation.kind !== 'permission'
  ) return null;
  const presentation = decision.presentation;
  return {
    requestId: decision.decisionId,
    ...(decision.runId === undefined ? {} : { runId: decision.runId }),
    ...(decision.sessionId === undefined ? {} : { sessionId: decision.sessionId }),
    title: presentation.headline,
    reason: presentation.summary,
    permissionItems: presentation.capabilityIds.map((capability) => ({
      itemId: `${decision.decisionId}:capability:${capability}`,
      capability,
      targetLabel: 'See the complete resource scope identifiers below.',
      reason: `Tool ${presentation.toolName} requests this capability.`,
      risk: 'critical',
      approvalScopes: ['once']
    })),
    status: decision.status,
    createdAt: decision.requestedAt,
    projectionVersion: decision.version,
    toolName: presentation.toolName,
    scopeIds: [...presentation.scopeIds],
    resourceSummary: presentation.resourceSummary,
    actionAvailable: isActionablePermissionDecision(decision)
  };
}

export function presentPlanDecision(
  decision: PublicDecisionProjectionV3
): RuntimePlanDecision | null {
  if (
    decision.kind !== 'plan'
    || decision.presentation.kind !== 'plan'
  ) return null;
  const presentation = decision.presentation;
  return {
    handoffId: decision.decisionId,
    ...(decision.runId === undefined ? {} : { runId: decision.runId }),
    ...(decision.sessionId === undefined ? {} : { sessionId: decision.sessionId }),
    title: presentation.headline,
    summary: presentation.summary,
    steps: presentation.steps.map((step, index) => ({
      stepId: `${decision.decisionId}:step:${String(index + 1)}`,
      title: step.title,
      detail: `${step.summary} Impact: ${step.impact}.`
    })),
    plan: null,
    status: decision.status,
    createdAt: decision.requestedAt,
    projectionVersion: decision.version,
    impactSummary: presentation.impactSummary,
    approvalScope: presentation.approvalScope,
    actionAvailable: isActionablePlanDecision(decision)
  };
}

export function presentUserQuestionDecision(
  decision: PublicDecisionProjectionV3
): RuntimeUserQuestionDecision | null {
  if (
    decision.kind !== 'user_question'
    || decision.presentation.kind !== 'user_question'
  ) return null;
  return {
    decisionId: decision.decisionId,
    runId: decision.runId,
    sessionId: decision.sessionId,
    projectionVersion: decision.version,
    status: decision.status,
    headline: decision.presentation.headline,
    prompt: decision.presentation.question,
    ...(decision.presentation.options === undefined
      ? {}
      : {
          options: decision.presentation.options.map((option) => ({
            optionId: option.optionId,
            label: option.label,
            ...(option.description === undefined
              ? {}
              : { description: option.description })
          }))
        }),
    actionAvailable: hasExactDecisionAction(decision, 'user_question', ['answer']),
    createdAt: decision.requestedAt
  };
}

function isActionablePermissionDecision(
  decision: PublicDecisionProjectionV3
): boolean {
  return hasExactDecisionAction(
    decision,
    'permission',
    ['allow_once', 'allow_run', 'deny']
  );
}

function isActionablePlanDecision(
  decision: PublicDecisionProjectionV3
): boolean {
  return hasExactDecisionAction(decision, 'plan', ['approve', 'reject']);
}

function hasExactDecisionAction(
  decision: PublicDecisionProjectionV3,
  kind: 'permission' | 'plan' | 'user_question',
  expectedChoices: readonly string[]
): boolean {
  const action = decision.action;
  return decision.kind === kind
    && decision.presentation.kind === kind
    && decision.status === 'pending'
    && Number.isSafeInteger(decision.version)
    && decision.version > 0
    && decision.runId.length > 0
    && action !== undefined
    && action.contractVersion === '1.0'
    && action.choices.length === expectedChoices.length
    && action.choices.every((choice, index) => choice === expectedChoices[index]);
}

export function presentModel(model: PublicModelProjectionV3): ModelSummary {
  return {
    id: model.modelId,
    label: model.label,
    location: model.location,
    availability: model.availability,
    supportsAgent: model.supportsAgent,
    supportsVision: model.supportsVision
  };
}

export function presentDiagnostic(
  diagnostic: PublicDiagnosticProjectionV3
): TraceEntry {
  return {
    traceId: diagnostic.diagnosticId,
    level: diagnostic.severity === 'warning' ? 'warning' : diagnostic.severity,
    category: diagnostic.code,
    message: diagnostic.message,
    occurredAt: diagnostic.observedAt
  };
}

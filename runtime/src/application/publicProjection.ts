import type {
  AgentProposal,
  PermissionRequest,
  PlanHandoff,
  MemoryRecord as PublicMemoryRecord,
  RunSummary,
  TraceEntry
} from '@ariadne/protocol/public';

import type { AgentProposal as SourceAgentProposal } from '../assistant/AgentHandoffContracts.js';
import type {
  CompanionMessage,
  CompanionSession
} from '../companion/CompanionSessionContracts.js';
import type { RunAggregate } from '../run/RunAggregateRepository.js';
import type { PermissionRequestPayload } from '../policy/permissionRequestTypes.js';
import type { PlanHandoffPayload } from '../policy/planHandoffTypes.js';
import type { TraceEvent } from '../trace/TraceLogger.js';
import type { MemoryRecord } from '../context/types.js';
import { toPublicError } from '../util/publicError.js';

export function projectSession(session: CompanionSession, workspaceId: string) {
  return {
    sessionId: session.id,
    workspaceId,
    title: session.title || '新会话',
    pinned: false,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  } as const;
}

export function projectMemory(memory: MemoryRecord): PublicMemoryRecord {
  if (memory.sensitivity === 'secret') {
    throw new Error('secret_memory_public_projection_denied');
  }
  return {
    memoryId: memory.id,
    scope: memory.scope,
    ...(memory.scopeId ? { scopeId: memory.scopeId } : {}),
    memoryType: memory.memoryType,
    ...(memory.key ? { key: memory.key } : {}),
    value: memory.value,
    ...(memory.summary ? { summary: memory.summary } : {}),
    importance: memory.importance,
    confidence: memory.confidence,
    lifecycleState: memory.lifecycleState,
    provenance: {
      origin: memory.provenance.origin,
      ...(memory.provenance.sourceId ? { sourceId: memory.provenance.sourceId } : {}),
      ...(memory.provenance.evidence ? { evidence: memory.provenance.evidence } : {})
    },
    sensitivity: memory.sensitivity,
    ...(memory.retentionUntil ? { retentionUntil: memory.retentionUntil } : {}),
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    ...(memory.lastUsedAt ? { lastUsedAt: memory.lastUsedAt } : {}),
    ...(memory.supersedesId ? { supersedesId: memory.supersedesId } : {})
  };
}

export function projectMessage(message: CompanionMessage) {
  const emptyCompletedAssistant =
    message.role === 'assistant'
    && message.status === 'completed'
    && !message.content.trim();
  const error = projectCompanionMessageError(message, emptyCompletedAssistant);
  const runId = typeof message.metadata?.runId === 'string'
    ? message.metadata.runId
    : typeof message.metadata?.agentRunId === 'string'
      ? message.metadata.agentRunId
      : typeof message.metadata?.companionRunId === 'string'
        ? message.metadata.companionRunId
        : undefined;
  const processingDurationMs = typeof message.metadata?.processingDurationMs === 'number'
    && Number.isFinite(message.metadata.processingDurationMs)
    && message.metadata.processingDurationMs >= 0
      ? Math.round(message.metadata.processingDurationMs)
      : undefined;
  return {
    messageId: message.id,
    sessionId: message.sessionId,
    ...(runId ? { runId } : {}),
    role: message.role === 'system_summary' ? 'system' as const : message.role,
    content: message.content,
    status: message.status === 'deleted' || emptyCompletedAssistant
      ? 'interrupted' as const
      : message.status,
    createdAt: message.createdAt,
    ...(processingDurationMs !== undefined ? { processingDurationMs } : {}),
    ...(message.reasoning
      ? {
          reasoning: {
            content: message.reasoning.content,
            status: message.reasoning.status,
            source: message.reasoning.source,
            startedAt: message.reasoning.startedAt,
            ...(message.reasoning.completedAt
              ? { completedAt: message.reasoning.completedAt }
              : {}),
            ...(message.reasoning.durationMs !== undefined
              ? { durationMs: message.reasoning.durationMs }
              : {}),
            ...projectReasoningSegments(message.metadata)
          }
        }
      : {}),
    ...(typeof message.metadata?.agentProposalId === 'string'
      ? { agentProposalId: message.metadata.agentProposalId }
      : {}),
    ...(error ? { error } : {})
  };
}

function projectReasoningSegments(
  metadata: Record<string, unknown> | undefined
): { segments?: Array<{
  segmentId: string;
  kind: 'thought' | 'intermediate_response';
  content: string;
  occurredAt: string;
  iteration?: number;
}> } {
  const source = metadata?.reasoningSegments;
  if (!Array.isArray(source)) return {};
  const segments = source.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const record = candidate as Record<string, unknown>;
    const segmentId = stringValue(record.segmentId);
    const content = stringValue(record.content);
    const occurredAt = stringValue(record.occurredAt);
    const kind = record.kind;
    if (
      !segmentId
      || !content
      || !occurredAt
      || !Number.isFinite(Date.parse(occurredAt))
      || (kind !== 'thought' && kind !== 'intermediate_response')
    ) {
      return [];
    }
    const iteration = typeof record.iteration === 'number'
      && Number.isInteger(record.iteration)
      && record.iteration >= 0
      ? record.iteration
      : undefined;
    return [{
      segmentId: segmentId.slice(0, 512),
      kind: kind as 'thought' | 'intermediate_response',
      content: content.slice(0, 200_000),
      occurredAt,
      ...(iteration !== undefined ? { iteration } : {})
    }];
  }).slice(-2_000);
  return segments.length > 0 ? { segments } : {};
}

export function isPublicConversationMessage(message: CompanionMessage): boolean {
  const responseType = message.metadata?.responseType;
  return responseType !== "agent_proposal"
    && responseType !== "agent_proposal_delivery_pending";
}

function projectCompanionMessageError(
  message: CompanionMessage,
  emptyCompletedAssistant = false
) {
  if (emptyCompletedAssistant) {
    return {
      code: 'COMPANION_EMPTY_RESPONSE',
      message: companionMessageErrorText('COMPANION_EMPTY_RESPONSE'),
      retryable: true
    };
  }
  if (message.status !== 'interrupted' && message.status !== 'deleted') return undefined;
  const code = typeof message.metadata?.errorCode === 'string'
    ? message.metadata.errorCode
    : typeof message.metadata?.interruptionCode === 'string'
      ? message.metadata.interruptionCode
      : 'COMPANION_REPLY_INTERRUPTED';
  return {
    code,
    message: companionMessageErrorText(code),
    retryable: code !== 'cancelled' && code !== 'CANCELLED'
  };
}

function companionMessageErrorText(code: string): string {
  switch (code) {
    case 'COMPANION_TURN_PROTOCOL_ERROR':
      return 'Agent 提案未通过协议或业务校验，授权请求没有创建。详细阶段和字段路径已写入日志。';
    case 'COMPANION_EMPTY_RESPONSE':
      return '模型只返回了内部推理，没有生成最终回复。Ariadne 已尝试续写但仍未得到内容，请重试。';
    case 'service_restarted':
      return 'Runtime 重启中断了这条回复，请重新发送。';
    case 'AGENT_PLAN_BUDGET_EXHAUSTED':
      return '计划生成已暂停，可以从当前检查点追加预算后继续。';
    case 'AGENT_PLAN_DID_NOT_HANDOFF':
      return '计划模式没有生成可确认的计划，任务未进入执行阶段。';
    case 'cancelled':
    case 'CANCELLED':
      return '已停止生成。';
    default:
      return '回复生成中断，已保留成功接收的内容。';
  }
}

export function projectAgentProposal(proposal: SourceAgentProposal): AgentProposal {
  return {
    proposalId: proposal.id,
    ...(proposal.companionSessionId ? { sessionId: proposal.companionSessionId } : { sessionId: proposal.sourceTurnId }),
    title: proposal.interpretedTask.slice(0, 512),
    reason: proposal.reason,
    originalRequest: proposal.originalRequest,
    workspaceIds: [proposal.workspaceKey],
    requestedScopes: [...proposal.requestedScope],
    requestedCapabilities: [...proposal.requestedCapabilities],
    risk: proposal.risk,
    status: proposal.status,
    createdAt: proposal.createdAt
  };
}

export function projectRun(
  run: RunAggregate,
  publicSessionId = run.sessionId,
  timing: RunSummary["timing"] = {
    activeDurationMs: Math.max(0, Date.parse(run.updatedAt) - Date.parse(run.createdAt)),
  },
): RunSummary {
  const budgetDetails = projectedBudgetDetails(run);
  return {
    runId: run.id,
    ...(publicSessionId ? { sessionId: publicSessionId } : {}),
    ...(run.taskId ? { sourceMessageId: run.taskId } : {}),
    origin: 'agent',
    title: (run.goal?.trim() || `${run.kind} run`).slice(0, 512),
    status: publicRunStatus(run.status, run.waitReason),
    userFacingLabel: runLabel(run.status, run.waitReason),
    aggregateVersion: run.aggregateVersion,
    checkpointStage: run.checkpointStage,
    recoveryStatus: run.recoveryStatus,
    timing,
    ...budgetDetails,
    ...(run.error ? { detail: toPublicError(run.error).message } : {}),
    startedAt: run.createdAt,
    ...(isTerminalRunStatus(run.status) ? { completedAt: run.updatedAt } : {})
  };
}

export interface PublicPermissionWorkspace {
  workspaceId: string;
  workspaceLabel: string;
}

export function projectPermissionRequest(
  request: PermissionRequestPayload,
  workspace?: PublicPermissionWorkspace
): PermissionRequest {
  return {
    requestId: request.id,
    runId: request.runId,
    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    ...(workspace ? workspace : {}),
    approvalVersion: request.approvalVersion,
    title: request.title,
    reason: request.summary,
    permissionItems: request.requiredPermissions.map((item) => ({
      itemId: item.id,
      capability: item.type,
      targetLabel: item.target.slice(0, 1_024),
      reason: item.reason,
      risk: item.riskTier ?? defaultRisk(item.type),
      approvalScopes: permissionApprovalScopes(request, item)
    })),
    status: request.status === 'denied' || request.status === 'expired'
      ? 'rejected'
      : request.status,
    createdAt: request.createdAt
  };
}

export function projectPlanHandoff(
  handoff: PlanHandoffPayload,
  publicSessionId = handoff.sessionId,
): PlanHandoff {
  const plan = handoff.plan ?? legacyRejectedPlan(handoff);
  const steps = plan.steps.length > 0
    ? plan.steps.map((step) => ({
        stepId: step.id,
        title: step.title.slice(0, 512),
        detail: step.expectedOutcome.slice(0, 8_192)
      }))
    : [{
        stepId: `${handoff.id}:legacy`,
        title: '旧版计划不可执行',
        detail: '该记录没有结构化计划契约，请重新生成计划。'
      }];
  return {
    handoffId: handoff.id,
    runId: handoff.runId,
    ...(publicSessionId ? { sessionId: publicSessionId } : {}),
    plan,
    title: plan.title,
    summary: plan.goal,
    steps,
    status: handoff.plan ? handoff.status : 'rejected',
    createdAt: handoff.createdAt
  };
}

function legacyRejectedPlan(handoff: PlanHandoffPayload): PlanHandoff['plan'] {
  return {
    schemaVersion: 1,
    planId: handoff.planId,
    version: handoff.planVersion ?? 1,
    sourceRunId: handoff.runId,
    ...(handoff.sessionId ? { sessionId: handoff.sessionId } : {}),
    title: '旧版计划需要重新生成',
    goal: handoff.message,
    facts: [{
      id: 'legacy-plan-record',
      statement: '该计划由旧版 Markdown 交接协议创建。',
      evidence: '持久化记录中不存在结构化 plan 字段。'
    }],
    constraints: [],
    clarifications: [],
    steps: [],
    completionCriteria: [],
    planState: 'superseded',
    executionState: 'failed',
    completeness: 'incomplete',
    blockingReasons: ['旧版记录缺少可验证的结构化计划契约，不能继续执行。'],
    qualityIssues: [{
      code: 'invalid_schema',
      severity: 'critical',
      message: '旧版计划必须重新生成后才能批准。',
      path: 'plan'
    }],
    createdAt: handoff.createdAt,
    updatedAt: handoff.createdAt
  };
}

export function projectTraceEvent(event: TraceEvent, fallbackId: string): TraceEntry {
  const record = event as Record<string, unknown>;
  const type = String(record.type ?? 'unknown').slice(0, 128);
  const category = stringValue(record.category)?.slice(0, 128) ?? type;
  const explicitMessage = sanitizePublicTraceMessage(
    firstPublicText(record, ['message', 'summary', 'error', 'reason'])
  );
  const conciseMessage = conciseTraceMessage(type, record);
  const message = prefersConciseTraceMessage(type)
    ? conciseMessage || explicitMessage
    : explicitMessage || conciseMessage;
  const metadata = publicTraceMetadata(record.metadata);
  const time = typeof record.time === 'string' && Number.isFinite(Date.parse(record.time))
    ? record.time
    : new Date().toISOString();
  return {
    traceId: typeof record.eventId === 'string' && record.eventId ? record.eventId : fallbackId,
    ...(typeof record.runId === 'string' && record.runId ? { runId: record.runId } : {}),
    level: publicTraceLevel(record.level)
      ?? (type.includes('error') || type.includes('failed') || record.status === 'failed'
        ? 'error'
        : type.includes('warn') || type.includes('retry')
          ? 'warning'
          : 'info'),
    category,
    message: message.slice(0, 16_384),
    occurredAt: time,
    ...(metadata ? { metadata } : {})
  };
}

function prefersConciseTraceMessage(type: string): boolean {
  return type === 'companion.turn.input'
    || type === 'companion.turn.completed'
    || type === 'agent_decision'
    || type === 'path_access_decision'
    || type === 'agent_model_turn'
    || type === 'assistant_agent_proposal_created'
    || type === 'assistant_agent_proposal_settled'
    || type === 'assistant_agent_proposal_resumed_settled'
    || type === 'assistant_agent_grant_consumed';
}

function sanitizePublicTraceMessage(value: string | undefined): string {
  if (!value) return '';
  return value
    .replace(/^(?:Error|INTERNAL_ERROR|UNKNOWN_ERROR|RUNTIME_ERROR):\s*/iu, '')
    .trim()
    .slice(0, 1_024);
}

function conciseTraceMessage(type: string, record: Record<string, unknown>): string {
  const status = stringValue(record.status);
  const tool = stringValue(record.tool);
  switch (type) {
    case 'run_start': return '任务已开始。';
    case 'run_resume': return '任务已恢复执行。';
    case 'run_end': return status ? `任务状态：${publicStatusLabel(status)}。` : '任务已结束。';
    case 'tool_audit':
    case 'agent_tool':
      if (status === 'start') return tool ? `正在执行工具 ${tool}。` : '工具开始执行。';
      if (status === 'ok') return tool ? `工具 ${tool} 执行完成。` : '工具执行完成。';
      if (status) return tool
        ? `工具 ${tool} 状态：${publicStatusLabel(status)}。`
        : `工具状态：${publicStatusLabel(status)}。`;
      return tool ? `Agent 调用了工具 ${tool}。` : 'Agent 调用了工具。';
    case 'agent_decision': return 'Agent 完成了一次执行决策。';
    case 'path_access_decision': return '工作区访问策略已完成判定。';
    case 'agent_model_turn': return 'Agent 完成了一次模型推理。';
    case 'model_call': return '模型调用已完成。';
    case 'companion.turn.input': return '已提交一轮对话。';
    case 'companion.turn.completed': return '本轮对话已完成。';
    case 'assistant_agent_proposal_created': return '已创建 Agent 执行提案，等待确认。';
    case 'assistant_agent_proposal_settled':
    case 'assistant_agent_proposal_resumed_settled':
      return status ? `Agent 提案状态：${publicStatusLabel(status)}。` : 'Agent 提案状态已更新。';
    case 'assistant_agent_grant_consumed': return '本次 Agent 授权已使用。';
    case 'browser_capability_registered': return '浏览器能力已就绪。';
    case 'scheduler_register': return '后台任务已注册。';
    default: return '';
  }
}

function publicStatusLabel(status: string): string {
  return {
    completed: '已完成',
    failed: '失败',
    paused: '已暂停',
    waiting_confirmation: '等待确认',
    waiting_permission: '等待授权',
    observation_failure: '结果验证未通过',
    execution_error: '执行失败',
    cancelled: '已取消',
    rejected: '已拒绝',
    ok: '成功',
    start: '开始'
  }[status] ?? status.replaceAll('_', ' ');
}

function publicRunStatus(
  status: RunAggregate['status'],
  waitReason?: RunAggregate['waitReason'],
): RunSummary['status'] {
  switch (status) {
    case 'pending': return 'queued';
    case 'running': return 'running';
    case 'blocked':
    case 'waiting_confirmation': return 'waiting_permission';
    case 'waiting_plan_handoff': return 'waiting_plan_handoff';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'paused': return waitReason?.code === 'budget_exhausted' ? 'waiting_budget' : 'paused';
    case 'recovery_required': return 'interrupted';
  }
}

function runLabel(
  status: RunAggregate['status'],
  waitReason?: RunAggregate['waitReason'],
): string {
  switch (status) {
    case 'pending': return '等待执行';
    case 'running': return '正在执行';
    case 'blocked':
    case 'waiting_confirmation': return '等待权限确认';
    case 'waiting_plan_handoff': return '等待计划确认';
    case 'completed': return '已完成';
    case 'failed': return '执行失败';
    case 'cancelled': return '已取消';
    case 'paused': return waitReason?.code === 'budget_exhausted'
      ? '等待追加执行预算'
      : '执行已暂停';
    case 'recovery_required': return '需要恢复决策';
  }
}

function projectedBudgetDetails(run: RunAggregate): Pick<
  RunSummary,
  'budgetUsage' | 'suggestedBudget' | 'budgetExhausted'
> {
  if (run.waitReason?.code !== 'budget_exhausted') return {};
  const details = objectValue(run.waitReason.details);
  const result = objectValue(details.result ?? details);
  const executionMeta = objectValue(result.executionMeta);
  const runState = objectValue(result.runState);
  const usage = objectValue(runState.budgetUsage ?? executionMeta.usage);
  const suggested = objectValue(runState.suggestedBudget ?? executionMeta.suggestedBudget);
  const budgetExhausted = typeof runState.budgetExhausted === 'string'
    ? runState.budgetExhausted
    : executionMeta.budgetExhausted;
  return {
    ...(Object.keys(usage).length > 0
      ? { budgetUsage: usage as RunSummary['budgetUsage'] }
      : {}),
    ...(Object.keys(suggested).length > 0
      ? { suggestedBudget: suggested as RunSummary['suggestedBudget'] }
      : {}),
    ...(typeof budgetExhausted === 'string'
      ? { budgetExhausted }
      : {}),
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isTerminalRunStatus(status: RunAggregate['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function permissionApprovalScopes(
  request: PermissionRequestPayload,
  item: PermissionRequestPayload['requiredPermissions'][number]
): Array<'once' | 'session' | 'project' | 'workspace'> {
  const scopes: Array<'once' | 'session' | 'project' | 'workspace'> = ['once'];
  if (request.sessionId) scopes.push('session');
  const persistentType = item.type === 'read_file'
    || item.type === 'write_file'
    || item.type === 'delete_file';
  if (request.projectId && (persistentType || (item.type === 'shell' && Boolean(item.rootPath)))) {
    scopes.push('project');
  }
  if (persistentType) scopes.push('workspace');
  return scopes;
}

function defaultRisk(type: string): 'low' | 'medium' | 'high' | 'critical' {
  if (type === 'read_file') return 'low';
  if (type === 'write_file' || type === 'network') return 'medium';
  if (type === 'shell') return 'high';
  return 'critical';
}

function firstPublicText(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function eventTime(record: Record<string, unknown>): string {
  for (const key of ['time', 'at']) {
    const value = stringValue(record[key]);
    if (value && Number.isFinite(Date.parse(value))) return value;
  }
  return new Date().toISOString();
}

function publicTraceLevel(value: unknown): TraceEntry['level'] | undefined {
  return value === 'debug'
    || value === 'info'
    || value === 'warning'
    || value === 'error'
    ? value
    : undefined;
}

function publicTraceMetadata(value: unknown): TraceEntry['metadata'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || serialized === '{}') return undefined;
    if (serialized.length > 32_768) {
      return {
        truncated: true,
        preview: serialized.slice(0, 32_000)
      };
    }
    return JSON.parse(serialized) as TraceEntry['metadata'];
  } catch {
    return {
      serializationError: true
    };
  }
}

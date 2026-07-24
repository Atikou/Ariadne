import type {
  AgentProposal,
  PermissionRequest,
  PlanHandoff,
  MemoryRecord as PublicMemoryRecord,
  RunActivity,
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
  return {
    messageId: message.id,
    sessionId: message.sessionId,
    role: message.role === 'system_summary' ? 'system' as const : message.role,
    content: message.content,
    status: message.status === 'deleted' || emptyCompletedAssistant
      ? 'interrupted' as const
      : message.status,
    createdAt: message.createdAt,
    ...(typeof message.metadata?.agentProposalId === 'string'
      ? { agentProposalId: message.metadata.agentProposalId }
      : {}),
    ...(error ? { error } : {})
  };
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

export function projectRun(run: RunAggregate): RunSummary {
  return {
    runId: run.id,
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    origin: 'agent',
    title: (run.goal?.trim() || `${run.kind} run`).slice(0, 512),
    status: publicRunStatus(run.status),
    userFacingLabel: runLabel(run.status),
    aggregateVersion: run.aggregateVersion,
    checkpointStage: run.checkpointStage,
    recoveryStatus: run.recoveryStatus,
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

export function projectPlanHandoff(handoff: PlanHandoffPayload): PlanHandoff {
  const markdownSteps = handoff.planMarkdown
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(?:[-*]|\d+\.)\s+(?:\[[ xX]\]\s*)?(.+)$/)?.[1]?.trim())
    .filter((line): line is string => Boolean(line))
    .slice(0, 512);
  const steps = (markdownSteps.length > 0 ? markdownSteps : [handoff.message]).map((title, index) => ({
    stepId: `${handoff.id}:${index + 1}`,
    title: title.slice(0, 512)
  }));
  return {
    handoffId: handoff.id,
    runId: handoff.runId,
    title: '执行计划待确认',
    summary: handoff.message,
    steps,
    status: handoff.status,
    createdAt: handoff.createdAt
  };
}

export function projectTraceEvent(event: TraceEvent, fallbackId: string): TraceEntry {
  const record = event as Record<string, unknown>;
  const type = String(record.type ?? 'unknown').slice(0, 128);
  const category = stringValue(record.category)?.slice(0, 128) ?? type;
  const message = firstPublicText(record, ['message', 'summary', 'error', 'reason']) ?? '';
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

export function projectRunActivity(event: TraceEvent): RunActivity | null {
  const record = event as Record<string, unknown>;
  const type = stringValue(record.type);
  const runId = stringValue(record.runId)
    ?? stringValue(record.planRunId)
    ?? stringValue(record.sourceRunId);
  if (!type || !runId) return null;
  const occurredAt = eventTime(record);
  const eventId = stringValue(record.eventId) ?? `${type}:${runId}:${occurredAt}`;
  if (type === 'tool_audit' || type === 'agent_tool') {
    const tool = stringValue(record.tool) ?? '工具';
    const toolCallId = stringValue(record.toolCallId) ?? eventId;
    const status = stringValue(record.status);
    const failed = status === 'execution_error'
      || status === 'observation_failure'
      || status === 'failed';
    const summary = firstPublicText(record, ['userDisplay', 'outputPreview', 'error', 'message']);
    return {
      activityId: `tool:${toolCallId}`,
      runId,
      kind: 'tool',
      status: failed ? 'failed' : status === 'start' || !status ? 'running' : 'completed',
      title: tool,
      ...(summary ? { summary: summary.slice(0, 8_192) } : {}),
      occurredAt
    };
  }
  if (type === 'plan_event') {
    const eventType = stringValue(record.eventType) ?? 'plan';
    const status = stringValue(record.status);
    const summary = firstPublicText(record, ['error', 'outputPreview']);
    return {
      activityId: `plan:${stringValue(record.stepId) ?? eventId}`,
      runId,
      kind: 'plan',
      status: eventType.includes('failed') || status === 'failed'
        ? 'failed'
        : eventType.includes('completed') || status === 'completed'
          ? 'completed'
          : 'running',
      title: eventType,
      ...(summary ? { summary: summary.slice(0, 8_192) } : {}),
      occurredAt
    };
  }
  if (type === 'run_start' || type === 'run_resume' || type === 'run_end' || type === 'run_resume_failed') {
    const status = stringValue(record.status);
    const failed = type === 'run_resume_failed' || status === 'failed';
    return {
      activityId: `run:${eventId}`,
      runId,
      kind: failed ? 'warning' : 'status',
      status: failed ? 'failed' : type === 'run_end' ? 'completed' : 'running',
      title: type === 'run_start'
        ? 'Agent 开始执行'
        : type === 'run_resume'
          ? 'Agent 恢复执行'
          : type === 'run_resume_failed'
            ? 'Agent 恢复失败'
            : status === 'cancelled'
              ? 'Agent 已取消'
              : 'Agent 执行结束',
      ...(status ? { summary: status.slice(0, 8_192) } : {}),
      occurredAt
    };
  }
  return null;
}

function publicRunStatus(status: RunAggregate['status']): RunSummary['status'] {
  switch (status) {
    case 'pending': return 'queued';
    case 'running': return 'running';
    case 'blocked':
    case 'waiting_confirmation': return 'waiting_permission';
    case 'waiting_plan_handoff': return 'waiting_plan_handoff';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'paused':
    case 'recovery_required': return 'interrupted';
  }
}

function runLabel(status: RunAggregate['status']): string {
  switch (status) {
    case 'pending': return '等待执行';
    case 'running': return '正在执行';
    case 'blocked':
    case 'waiting_confirmation': return '等待权限确认';
    case 'waiting_plan_handoff': return '等待计划确认';
    case 'completed': return '已完成';
    case 'failed': return '执行失败';
    case 'cancelled': return '已取消';
    case 'paused': return '执行已中断';
    case 'recovery_required': return '需要恢复决策';
  }
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

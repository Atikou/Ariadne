import { getActiveDecision, type AgentRun } from '@ariadne/agent-core';
import { TASK_CENTER_QUERY_VERSION, taskCenterNavigationSchema, taskCenterNavigationResultSchema,
  taskSourceMetadataSchema, type TaskCenterNavigation, type TaskCenterNavigationResult, type TaskSourceMetadata,
  type ConversationMessageReference } from '@ariadne/protocol/public';
import { publicRunStatus } from '../projection/AgentRunPublicProjectionPublisher.js';
import { taskRunState, type TaskCenterSources } from './TaskCenterSourceCollector.js';
import { deriveConversationAuthorityId } from '../conversation/ConversationRunHandoffIds.js';
import { PUBLIC_PROJECTION_CATALOG_VERSION } from '@ariadne/protocol/public';
import { ScheduleExecutionFacts } from './ScheduleExecutionFacts.js';

/** Revalidation only. Mutations stay behind the original versioned command owners. */
export class TaskCenterNavigationResolver {
  private readonly authorized: ReadonlySet<string>;
  constructor(private readonly sources: TaskCenterSources) { this.authorized = new Set(sources.authorizedWorkspaceIds); }
  async resolve(input: TaskCenterNavigation, signal: AbortSignal): Promise<TaskCenterNavigationResult> {
    const request = taskCenterNavigationSchema.parse(input);
    const result = (status: TaskCenterNavigationResult['status'], current: TaskSourceMetadata | null = null,
      target: TaskCenterNavigationResult['target'] = null): TaskCenterNavigationResult => taskCenterNavigationResultSchema.parse({
      kind: 'tasks.navigate_result', contractVersion: TASK_CENTER_QUERY_VERSION, status,
      reference: request.reference, workspaceId: request.workspaceId, sessionId: request.sessionId, current, target });
    signal.throwIfAborted();
    if (this.authorized.size && !this.authorized.has(request.workspaceId)) return result('unauthorized');
    const owner = await this.sources.conversation.readSession(request.sessionId);
    signal.throwIfAborted();
    if (owner === null || owner.workspaceId !== request.workspaceId) return result('missing');
    if (owner.status === 'archived') return result('archived');
    let run: AgentRun | null = null;
    let metadata: TaskSourceMetadata | null;
    if (request.reference.source === 'run') {
      run = await this.ownedRun(request.reference.sourceId, request.workspaceId, request.sessionId);
      if (run === null) return result('missing');
      const cached = this.sources.index.currentItem(request.reference);
      metadata = taskSourceMetadataSchema.parse({ reference: request.reference, workspaceId: request.workspaceId,
        sessionId: request.sessionId, title: cached?.metadata.title ?? `Agent 任务 #${run.runId.slice(-8)}`,
        sourceStatus: publicRunStatus(run), state: taskRunState(publicRunStatus(run)), version: run.version, attempts: null,
        updatedAt: run.updatedAt, dueAt: null, relations: [], relationTotal: 0, runReferences: [], runReferenceTotal: 0 });
    } else {
      const store = this.sources.productivity;
      if (store === undefined) return result('unavailable');
      metadata = await store.readTaskCatalogItem({ workspaceIds: [request.workspaceId],
        session: { workspaceId: request.workspaceId, sessionId: request.sessionId } },
      { source: request.reference.source, sourceId: request.reference.sourceId });
      if (metadata === null) return result('missing');
    }
    signal.throwIfAborted();
    if (metadata.version !== request.expectedVersion || metadata.attempts !== request.expectedAttempts
      || metadata.sourceStatus !== request.expectedSourceStatus) return result('stale', metadata);
    const navigate = async (target: NonNullable<TaskCenterNavigationResult['target']>) => {
      signal.throwIfAborted();
      const targetOwner = await this.sources.conversation.readSession(target.sessionId);
      if (targetOwner === null || targetOwner.workspaceId !== target.workspaceId) return result('missing');
      if (targetOwner.status === 'archived') return result('archived', metadata);
      if (target.runId !== null) {
        const latest = await this.ownedRun(target.runId, target.workspaceId, target.sessionId);
        if (latest === null) return result('missing');
        if (latest.version !== target.expectedRunVersion) return result('stale', metadata);
      }
      if (request.reference.source !== 'run') {
        const latest = await this.sources.productivity?.readTaskCatalogItem({ workspaceIds: [request.workspaceId],
          session: { workspaceId: request.workspaceId, sessionId: request.sessionId } },
        { source: request.reference.source, sourceId: request.reference.sourceId });
        if (!latest) return result('missing');
        if (latest.version !== request.expectedVersion || latest.attempts !== request.expectedAttempts
          || latest.sourceStatus !== request.expectedSourceStatus) return result('stale', latest);
      }
      signal.throwIfAborted(); return result('ok', metadata, target);
    };
    let resultReference: ConversationMessageReference | null = null;
    if (metadata.reference.source === 'occurrence' && this.sources.productivity
      && (request.destination === 'decision' || request.destination === 'result')) {
      const fact = await new ScheduleExecutionFacts(this.sources.productivity, this.sources.conversation, this.sources.loadRun)
        .read(metadata.reference.sourceId, request.workspaceId, request.sessionId, metadata.sourceStatus === 'submitted', signal);
      if (fact?.runId) run = await this.ownedRun(fact.runId, request.workspaceId, request.sessionId);
      resultReference = fact?.resultReference ?? null;
    }
    if (request.destination === 'decision') {
      const references = run ? [{ runId: run.runId, workspaceId: request.workspaceId, sessionId: request.sessionId }]
        : metadata.runReferences;
      for (const reference of references) {
        signal.throwIfAborted();
        const candidate = run ?? await this.ownedRun(reference.runId, reference.workspaceId, reference.sessionId);
        if (candidate === null) continue;
        const active = getActiveDecision(candidate);
        if (active?.decisionId !== request.decisionId) continue;
        const decision = await this.pendingDecision(reference.workspaceId, reference.sessionId, candidate.runId,
          request.decisionId!, request.expectedDecisionVersion!, signal);
        if (!decision) return result('stale', metadata);
        return navigate({ moduleId: decision.kind === 'permission' ? 'permissions'
          : decision.kind === 'plan' ? 'agent.plan' : decision.kind === 'user_question' ? 'chat.main' : 'agent.status', runId: candidate.runId, expectedRunVersion: candidate.version,
          workspaceId: reference.workspaceId, sessionId: reference.sessionId,
          decisionId: decision.decisionId, expectedDecisionVersion: decision.version, resultReference: null });
      }
      return result('stale', metadata);
    }
    if (request.destination === 'result') {
      if (resultReference === null && run !== null) resultReference = await this.resultReference(run);
      signal.throwIfAborted();
      if (resultReference === null) return result(run && ['completed', 'failed', 'cancelled'].includes(run.state.status) ? 'pending' : 'unavailable', metadata);
      return navigate({ moduleId: 'chat.main', workspaceId: request.workspaceId, sessionId: resultReference.sessionId, runId: run?.runId ?? null,
        expectedRunVersion: run?.version ?? null, decisionId: null, expectedDecisionVersion: null, resultReference });
    }
    signal.throwIfAborted();
    return navigate({ moduleId: metadata.reference.source === 'run' ? 'agent.status' : 'productivity.control',
      workspaceId: request.workspaceId, sessionId: request.sessionId,
      runId: run?.runId ?? null, expectedRunVersion: run?.version ?? null,
      decisionId: null, expectedDecisionVersion: null, resultReference: null });
  }
  private async ownedRun(runId: string, workspaceId: string, sessionId: string): Promise<AgentRun | null> {
    if (this.authorized.size && !this.authorized.has(workspaceId)) return null;
    const run = await this.sources.loadRun(runId);
    return run?.binding.workspace.workspaceId === workspaceId && run.binding.sessionId === sessionId ? run : null;
  }
  private async resultReference(run: AgentRun): Promise<ConversationMessageReference | null> {
    if (run.binding.objectiveRef.kind !== 'conversation_message') return null;
    const objective = run.binding.objectiveRef;
    const saga = await this.sources.conversation.readSagaByMessage(objective.messageId, objective.messageVersion);
    if (saga?.workspaceId !== run.binding.workspace.workspaceId || saga.sessionId !== run.binding.sessionId
      || saga.objectiveDigest !== objective.contentDigest || saga.stage.kind !== 'agent_result_projected'
      || saga.stage.runId !== run.runId || saga.stage.resultRunVersion !== run.version || saga.stage.resultStatus !== run.state.status) return null;
    const id = await deriveConversationAuthorityId('agent-result-message', saga.stage.sourceRunEventId);
    const identity = await this.sources.conversation.readMessageIdentity(id, 1);
    return identity?.role === 'assistant' && identity.workspaceId === run.binding.workspace.workspaceId
      && identity.reference.sessionId === run.binding.sessionId ? identity.reference : null;
  }
  private async pendingDecision(workspaceId: string, sessionId: string, runId: string, decisionId: string,
    version: number, signal: AbortSignal) {
    const manifest = await this.sources.projection.beginCatalogSnapshot({ pageContractVersion: PUBLIC_PROJECTION_CATALOG_VERSION,
      scope: { kind: 'session', workspaceId, sessionId }, feature: 'decisions', filter: 'pending' });
    if ('status' in manifest) return null;
    let cursor: string | undefined;
    do {
      signal.throwIfAborted();
      const page = await this.sources.projection.readCatalogPage({ manifest, limit: 32,
        ...(cursor === undefined ? {} : { pageCursor: cursor }) });
      if (page.status !== 'ok') return null;
      const found = page.rows.find(row => row.feature === 'decisions' && row.dto.decisionId === decisionId
        && row.dto.runId === runId && row.dto.version === version);
      if (found?.feature === 'decisions') return found.dto;
      cursor = page.nextPageCursor;
    } while (cursor !== undefined);
    return null;
  }
}

import { useSyncExternalStore } from 'react';

import type {
  AgentProposal,
  ChatRoutingStrategy,
  CompanionMessage,
  ConversationSession,
  ModelSummary,
  ModelInferenceOptions,
  PermissionRequest,
  PlanHandoff,
  RunActivity,
  RunSummary,
  RuntimeCommand,
  RuntimeEvent,
  RuntimeEventEnvelope,
  RuntimeResult,
  RuntimeStatus,
  TraceEntry,
  WorkspaceAccessMode
} from '@ariadne/protocol/public';
import type { AriadneApi } from '@shared/contract';

export interface RuntimeSnapshot {
  initialized: boolean;
  status: RuntimeStatus;
  sessions: ConversationSession[];
  selectedSessionId: string | null;
  messages: RuntimeMessage[];
  models: ModelSummary[];
  proposals: AgentProposal[];
  runs: RunSummary[];
  activities: RunActivity[];
  permissions: PermissionRequest[];
  planHandoffs: PlanHandoff[];
  trace: TraceEntry[];
  lastError: string | null;
}

export type RuntimeMessage = CompanionMessage & {
  deliveryState?: 'pending' | 'failed';
};

interface PendingChatTurn {
  clientMessageId: string;
  assistantPlaceholderId: string;
  provisionalSessionId: string;
  actualSessionId?: string;
  actualAssistantMessageId?: string;
}

export interface CreateSessionOptions {
  title?: string;
  workspaceId?: string;
}

export interface SendMessageOptions {
  modelId?: string;
  inference?: ModelInferenceOptions;
  routingStrategy?: ChatRoutingStrategy;
  workspaceId?: string;
}

export class RuntimeStore {
  private snapshot: RuntimeSnapshot = {
    initialized: false,
    status: {
      availability: 'stopped',
      capabilities: [],
      observedAt: new Date(0).toISOString()
    },
    sessions: [],
    selectedSessionId: null,
    messages: [],
    models: [],
    proposals: [],
    runs: [],
    activities: [],
    permissions: [],
    planHandoffs: [],
    trace: [],
    lastError: null
  };
  private readonly listeners = new Set<() => void>();
  private initializePromise: Promise<void> | null = null;
  private initializationGeneration = 0;
  private statusRevision = 0;
  private refreshPromise: Promise<void> | null = null;
  private modelCheckPromise: Promise<void> | null = null;
  private removeEventListener: (() => void) | null = null;
  private snapshotRevision: number | null = null;
  private lastEventCursor = 0;
  private readonly seenEventIds = new Set<string>();
  private readonly aggregateVersions = new Map<string, number>();
  private bufferedEvents: RuntimeEventEnvelope[] = [];
  private sessionSelectionGeneration = 0;
  private pendingChatTurn: PendingChatTurn | null = null;

  constructor(private readonly api: AriadneApi['runtime']) {}

  getSnapshot = (): RuntimeSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  initialize(): Promise<void> {
    if (!this.initializePromise) {
      const generation = ++this.initializationGeneration;
      this.removeEventListener = this.api.onEvent((event) => {
        if (generation === this.initializationGeneration) this.receiveEvent(event);
      });
      this.initializePromise = this.initializeRuntime(generation);
    }
    return this.initializePromise;
  }

  dispose(): void {
    this.initializationGeneration += 1;
    this.sessionSelectionGeneration += 1;
    this.removeEventListener?.();
    this.removeEventListener = null;
    this.initializePromise = null;
    this.snapshotRevision = null;
    this.lastEventCursor = 0;
    this.seenEventIds.clear();
    this.aggregateVersions.clear();
    this.bufferedEvents = [];
  }

  async refresh(): Promise<void> {
    if (this.snapshot.status.availability !== 'ready') return;
    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshRuntime().finally(() => {
        this.refreshPromise = null;
      });
    }
    await this.refreshPromise;
  }

  private async refreshRuntime(): Promise<void> {
    this.update({ lastError: null });
    this.checkModelsInBackground();
    const selectedSessionId = this.snapshot.selectedSessionId;
    const domainSnapshot = await this.api.request({ kind: 'runtime.snapshot.get' });
    if (domainSnapshot.kind !== 'runtime.snapshot') {
      throw new Error('Runtime returned an invalid snapshot result.');
    }
    this.applyResult(domainSnapshot);
    const commands: RuntimeCommand[] = [
      { kind: 'models.list' },
      { kind: 'companion.sessions.list' },
      { kind: 'trace.list', limit: 200 }
    ];
    const settled = await Promise.allSettled(commands.map((command) => this.requestAndApply(command)));
    const rejected = settled.find((result) => result.status === 'rejected');
    if (rejected?.status === 'rejected') {
      this.setError(rejected.reason);
      return;
    }
    if (
      selectedSessionId
      && this.snapshot.selectedSessionId === selectedSessionId
      && this.snapshot.sessions.some((session) => session.sessionId === selectedSessionId)
    ) {
      try {
        const result = await this.api.request({
          kind: 'companion.messages.list',
          sessionId: selectedSessionId,
          limit: 500
        });
        if (result.kind !== 'companion.messages') {
          throw new Error('Runtime 返回了不符合预期的结果。');
        }
        if (this.snapshot.selectedSessionId === selectedSessionId) {
          this.update({ messages: result.messages, lastError: null });
        }
      } catch (error) {
        this.setError(error);
      }
    }
  }

  private checkModelsInBackground(): void {
    if (this.modelCheckPromise) return;
    this.modelCheckPromise = this.requestAndApply({ kind: 'models.check' })
      .then(() => undefined)
      .catch((error) => this.setError(error))
      .finally(() => {
        this.modelCheckPromise = null;
      });
  }

  private async requestAndApply(command: RuntimeCommand): Promise<RuntimeResult> {
    const result = await this.api.request(command);
    this.applyResult(result);
    return result;
  }

  async selectSession(sessionId: string): Promise<void> {
    const generation = ++this.sessionSelectionGeneration;
    this.update({ selectedSessionId: sessionId, messages: [], lastError: null });
    try {
      const result = await this.api.request({ kind: 'companion.messages.list', sessionId, limit: 500 });
      if (result.kind !== 'companion.messages') throw new Error('Runtime 返回了不符合预期的结果。');
      if (
        generation === this.sessionSelectionGeneration
        && this.snapshot.selectedSessionId === sessionId
      ) {
        this.update({ messages: result.messages, lastError: null });
      }
    } catch (error) {
      if (generation === this.sessionSelectionGeneration) this.setError(error);
      throw error;
    }
  }

  async createSession(options: CreateSessionOptions = {}): Promise<ConversationSession> {
    const command: RuntimeCommand = {
      kind: 'companion.sessions.create',
      ...(options.title ? { title: options.title } : {}),
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {})
    };
    const result = await this.command(command);
    if (result.kind !== 'companion.session') throw new Error('Runtime 返回了不符合预期的结果。');
    await this.selectSession(result.session.sessionId);
    return result.session;
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    await this.command({ kind: 'companion.sessions.rename', sessionId, title });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.command({ kind: 'companion.sessions.delete', sessionId });
    const sessions = this.snapshot.sessions.filter((session) => session.sessionId !== sessionId);
    if (this.snapshot.selectedSessionId === sessionId) {
      this.sessionSelectionGeneration += 1;
      const next = sessions[0];
      this.update({ sessions, selectedSessionId: next?.sessionId ?? null, messages: [] });
      if (next) await this.selectSession(next.sessionId);
      return;
    }
    this.update({ sessions });
  }

  async sendMessage(
    message: string,
    options: SendMessageOptions = {}
  ): Promise<{ runId: string; sessionId: string }> {
    if (this.pendingChatTurn) {
      throw new Error('上一条消息仍在提交，请稍候。');
    }
    const selectedSessionId = this.snapshot.selectedSessionId ?? undefined;
    const selectedWorkspaceId = this.snapshot.sessions.find(
      (session) => session.sessionId === selectedSessionId
    )?.workspaceId;
    const workspaceId = selectedWorkspaceId ?? options.workspaceId;
    const clientMessageId = crypto.randomUUID();
    const pendingSessionId = selectedSessionId ?? `pending:${clientMessageId}`;
    const assistantPlaceholderId = `pending-assistant:${clientMessageId}`;
    const createdAt = new Date().toISOString();
    const pendingTurn: PendingChatTurn = {
      clientMessageId,
      assistantPlaceholderId,
      provisionalSessionId: pendingSessionId
    };
    const optimisticUserMessage: RuntimeMessage = {
      messageId: clientMessageId,
      sessionId: pendingSessionId,
      role: 'user',
      content: message,
      status: 'completed',
      createdAt,
      deliveryState: 'pending'
    };
    const optimisticAssistantMessage: RuntimeMessage = {
      messageId: assistantPlaceholderId,
      sessionId: pendingSessionId,
      role: 'assistant',
      content: '',
      status: 'streaming',
      createdAt
    };
    this.pendingChatTurn = pendingTurn;
    this.update({
      messages: [
        ...this.snapshot.messages,
        optimisticUserMessage,
        optimisticAssistantMessage
      ],
      lastError: null
    });
    const command: RuntimeCommand = {
      kind: 'companion.chat.start',
      clientMessageId,
      message,
      resources: [],
      ...(selectedSessionId ? { sessionId: selectedSessionId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(options.modelId ? { modelId: options.modelId } : {}),
      ...(options.inference ? { inference: options.inference } : {}),
      ...(options.routingStrategy ? { routingStrategy: options.routingStrategy } : {})
    };
    try {
      const result = await this.command(command);
      if (result.kind !== 'companion.chat.accepted') throw new Error('Runtime 返回了不符合预期的结果。');
      const messages = this.snapshot.messages.map((item) => {
        if (item.messageId !== clientMessageId && item.messageId !== assistantPlaceholderId) return item;
        const acceptedMessage = { ...item };
        delete acceptedMessage.deliveryState;
        return { ...acceptedMessage, sessionId: result.sessionId };
      });
      if (this.pendingChatTurn?.clientMessageId === clientMessageId) {
        this.pendingChatTurn = {
          ...this.pendingChatTurn,
          actualSessionId: result.sessionId
        };
      }
      this.update({
        selectedSessionId: result.sessionId,
        messages
      });
      await this.reconcileAcceptedChat(result.sessionId);
      if (this.pendingChatTurn?.clientMessageId === clientMessageId) {
        this.pendingChatTurn = null;
      }
      return { runId: result.runId, sessionId: result.sessionId };
    } catch (error) {
      const errorMessage = runtimeRequestErrorMessage(error);
      if (this.snapshot.lastError !== errorMessage) this.setError(error);
      if (this.pendingChatTurn?.clientMessageId === clientMessageId) {
        this.update({
          messages: failPendingChatTurn(
            this.snapshot.messages,
            this.pendingChatTurn,
            errorMessage
          )
        });
        this.pendingChatTurn = null;
      }
      throw error;
    }
  }

  private async reconcileAcceptedChat(sessionId: string): Promise<void> {
    const [messagesResult, sessionsResult, runsResult] = await Promise.allSettled([
      this.api.request({ kind: 'companion.messages.list', sessionId, limit: 500 }),
      this.api.request({ kind: 'companion.sessions.list' }),
      this.api.request({ kind: 'runs.list', sessionId })
    ]);
    const patch: Partial<RuntimeSnapshot> = {};
    if (
      messagesResult.status === 'fulfilled'
      && messagesResult.value.kind === 'companion.messages'
      && this.snapshot.selectedSessionId === sessionId
    ) {
      patch.messages = messagesResult.value.messages;
    }
    if (
      sessionsResult.status === 'fulfilled'
      && sessionsResult.value.kind === 'companion.sessions'
    ) {
      patch.sessions = sessionsResult.value.sessions;
    }
    if (runsResult.status === 'fulfilled' && runsResult.value.kind === 'runs') {
      patch.runs = runsResult.value.runs;
    }
    if (Object.keys(patch).length > 0) this.update(patch);

    const rejected = [messagesResult, sessionsResult, runsResult].find(
      (result) => result.status === 'rejected'
    );
    if (rejected?.status === 'rejected') this.setError(rejected.reason);
  }

  async cancelAgentRun(runId: string): Promise<void> {
    await this.command({ kind: 'runs.cancel', runId });
  }

  async cancelCompanionRun(runId: string): Promise<void> {
    await this.command({ kind: 'companion.chat.cancel', runId });
  }

  async cancelRun(run: Pick<RunSummary, 'runId' | 'origin'>): Promise<void> {
    if (run.origin === 'companion') {
      await this.cancelCompanionRun(run.runId);
      return;
    }
    await this.cancelAgentRun(run.runId);
  }

  async respondToProposal(
    proposalId: string,
    decision: 'approve_once' | 'allow_session_read_only' | 'reject',
    options: {
      allowedCapabilities?: AgentProposal['requestedCapabilities'];
      workspaceId?: string;
      workspaceAccess?: WorkspaceAccessMode;
    } = {}
  ): Promise<void> {
    try {
      await this.command({
        kind: 'agent.proposals.respond',
        proposalId,
        decision,
        ...(options.allowedCapabilities ? { allowedCapabilities: options.allowedCapabilities } : {}),
        ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
        ...(options.workspaceAccess ? { workspaceAccess: options.workspaceAccess } : {})
      });
    } catch (error) {
      await this.requestAndApply({ kind: 'agent.proposals.list' }).catch(() => undefined);
      throw error;
    }
  }

  async respondToPermission(
    request: PermissionRequest,
    decision: 'allow_once' | 'allow_session' | 'allow_project' | 'allow_workspace' | 'deny',
    approvedItemIds = request.permissionItems.map((item) => item.itemId)
  ): Promise<void> {
    await this.command({
      kind: 'permissions.respond',
      requestId: request.requestId,
      approvalVersion: request.approvalVersion,
      decision,
      approvedItemIds
    });
  }

  async resumePermission(requestId: string): Promise<void> {
    await this.command({ kind: 'permissions.resume', requestId });
  }

  async respondToPlan(handoffId: string, decision: 'approve' | 'reject'): Promise<void> {
    await this.command({ kind: 'planHandoffs.respond', handoffId, decision });
  }

  async resumePlan(handoffId: string): Promise<void> {
    await this.command({ kind: 'planHandoffs.resume', handoffId });
  }

  private async initializeRuntime(generation: number): Promise<void> {
    const statusRevision = this.statusRevision;
    try {
      const status = await this.api.getStatus();
      if (generation !== this.initializationGeneration) return;
      this.update({ initialized: true, lastError: null });
      if (statusRevision === this.statusRevision) this.applyStatus(status);
      if (this.snapshot.status.availability === 'ready') await this.refresh();
    } catch (error) {
      if (generation !== this.initializationGeneration) return;
      this.update({ initialized: true });
      this.setError(error);
    }
  }

  private async command(command: RuntimeCommand): Promise<RuntimeResult> {
    try {
      const result = await this.api.request(command);
      this.applyResult(result);
      this.update({ lastError: null });
      return result;
    } catch (error) {
      this.setError(error);
      throw error;
    }
  }

  private applyResult(result: RuntimeResult): void {
    switch (result.kind) {
      case 'runtime.status':
        this.applyStatus(result.status);
        return;
      case 'runtime.snapshot':
        this.applyDomainSnapshot(result.snapshot);
        return;
      case 'events.replay':
        for (const event of result.events) this.receiveEvent(event);
        return;
      case 'models.catalog':
        this.update({ models: result.models });
        return;
      case 'companion.sessions': {
        const selectedSessionId = this.snapshot.selectedSessionId;
        const selectedSessionStillExists = selectedSessionId !== null
          && result.sessions.some((session) => session.sessionId === selectedSessionId);
        this.update({
          sessions: result.sessions,
          selectedSessionId: selectedSessionStillExists ? selectedSessionId : null,
          ...(selectedSessionStillExists ? {} : { messages: [] })
        });
        return;
      }
      case 'companion.session':
        this.update({ sessions: upsertBy(this.snapshot.sessions, result.session, 'sessionId') });
        return;
      case 'companion.messages':
        this.update({ messages: result.messages });
        return;
      case 'agent.proposals':
        this.update({ proposals: result.proposals });
        return;
      case 'agent.proposal':
        this.update({ proposals: upsertBy(this.snapshot.proposals, result.proposal, 'proposalId') });
        return;
      case 'runs':
        this.update({ runs: result.runs });
        return;
      case 'run':
        this.update({ runs: upsertBy(this.snapshot.runs, result.run, 'runId') });
        return;
      case 'permissions':
        this.update({ permissions: result.requests });
        return;
      case 'permission':
        this.update({ permissions: upsertBy(this.snapshot.permissions, result.request, 'requestId') });
        return;
      case 'planHandoffs':
        this.update({ planHandoffs: result.handoffs });
        return;
      case 'planHandoff':
        this.update({ planHandoffs: upsertBy(this.snapshot.planHandoffs, result.handoff, 'handoffId') });
        return;
      case 'trace':
        this.update({ trace: mergeTraceEntries(this.snapshot.trace, result.entries) });
    }
  }

  private applyDomainSnapshot(snapshot: Extract<RuntimeResult, { kind: 'runtime.snapshot' }>['snapshot']): void {
    this.snapshotRevision = snapshot.revision;
    this.lastEventCursor = Math.max(this.lastEventCursor, snapshot.revision);
    this.aggregateVersions.clear();
    for (const run of snapshot.runs) {
      this.aggregateVersions.set(`run:${run.runId}`, run.aggregateVersion);
    }
    this.update({
      runs: snapshot.runs,
      permissions: snapshot.permissions,
      planHandoffs: snapshot.planHandoffs,
      proposals: snapshot.proposals
    });
    const buffered = this.bufferedEvents
      .filter((event) => event.cursor > snapshot.revision)
      .sort((left, right) => left.cursor - right.cursor);
    this.bufferedEvents = [];
    for (const event of buffered) this.receiveEvent(event);
  }

  private receiveEvent(envelope: RuntimeEventEnvelope): void {
    if (this.snapshotRevision === null) {
      this.bufferedEvents.push(envelope);
      if (envelope.event.kind === 'runtime.status.changed') {
        this.applyEvent(envelope.event);
      }
      return;
    }
    if (envelope.cursor <= this.snapshotRevision || this.seenEventIds.has(envelope.eventId)) return;
    const aggregateKey = `${envelope.aggregateType}:${envelope.aggregateId}`;
    const currentVersion = this.aggregateVersions.get(aggregateKey) ?? 0;
    if (envelope.aggregateVersion <= currentVersion) return;
    this.aggregateVersions.set(aggregateKey, envelope.aggregateVersion);
    this.seenEventIds.add(envelope.eventId);
    if (this.seenEventIds.size > 4_000) {
      const oldest = this.seenEventIds.values().next();
      if (!oldest.done) this.seenEventIds.delete(oldest.value);
    }
    this.lastEventCursor = Math.max(this.lastEventCursor, envelope.cursor);
    this.applyEvent(envelope.event);
  }

  private applyEvent(event: RuntimeEvent): void {
    switch (event.kind) {
      case 'runtime.status.changed': {
        const becameReady = this.snapshot.status.availability !== 'ready'
          && event.status.availability === 'ready';
        this.statusRevision += 1;
        this.update({
          status: event.status,
          ...(event.status.availability === 'ready' ? {} : { models: [] })
        });
        if (becameReady) void this.refresh();
        return;
      }
      case 'companion.token.delta': {
        this.applyCompanionToken(event);
        return;
      }
      case 'companion.message.changed': {
        this.applyCompanionMessage(event.message);
        return;
      }
      case 'agent.proposal.changed':
        this.update({ proposals: upsertBy(this.snapshot.proposals, event.proposal, 'proposalId') });
        return;
      case 'run.changed': {
        const activityStatus = terminalActivityStatus(event.run.status);
        const activities = activityStatus
          ? this.snapshot.activities.map((activity) => activity.runId === event.run.runId
            && (activity.status === 'pending' || activity.status === 'running')
              ? { ...activity, status: activityStatus }
              : activity)
          : this.snapshot.activities;
        this.update({
          runs: upsertBy(this.snapshot.runs, event.run, 'runId'),
          ...(activities === this.snapshot.activities ? {} : { activities })
        });
        return;
      }
      case 'run.activity':
        this.update({ activities: upsertBy(this.snapshot.activities, event.activity, 'activityId') });
        return;
      case 'permission.changed':
        this.update({ permissions: upsertBy(this.snapshot.permissions, event.request, 'requestId') });
        return;
      case 'planHandoff.changed':
        this.update({ planHandoffs: upsertBy(this.snapshot.planHandoffs, event.handoff, 'handoffId') });
        return;
      case 'trace.appended':
        this.update({ trace: mergeTraceEntries(this.snapshot.trace, [event.entry]) });
    }
  }

  private applyCompanionToken(
    event: Extract<RuntimeEvent, { kind: 'companion.token.delta' }>
  ): void {
    const pendingTurn = this.pendingChatTurn;
    const belongsToPendingTurn = pendingTurn?.actualSessionId === event.sessionId
      || pendingTurn?.provisionalSessionId === event.sessionId;
    if (event.sessionId !== this.snapshot.selectedSessionId && !belongsToPendingTurn) return;

    const messages = removeAssistantPlaceholder(
      this.snapshot.messages,
      event.sessionId,
      pendingTurn?.assistantPlaceholderId
    );
    const existing = messages.find((message) => message.messageId === event.messageId);
    const message: RuntimeMessage = existing
      ? { ...existing, content: existing.content + event.text, status: 'streaming' }
      : {
          messageId: event.messageId,
          sessionId: event.sessionId,
          role: 'assistant',
          content: event.text,
          status: 'streaming',
          createdAt: new Date().toISOString()
        };
    if (pendingTurn && belongsToPendingTurn) {
      this.pendingChatTurn = {
        ...pendingTurn,
        actualAssistantMessageId: event.messageId
      };
    }
    this.update({ messages: upsertBy(messages, message, 'messageId') });
  }

  private applyCompanionMessage(message: CompanionMessage): void {
    const pendingTurn = this.pendingChatTurn;
    const isPendingUser = pendingTurn?.clientMessageId === message.messageId;
    const belongsToPendingTurn = isPendingUser
      || pendingTurn?.actualSessionId === message.sessionId
      || pendingTurn?.provisionalSessionId === message.sessionId;
    if (message.sessionId !== this.snapshot.selectedSessionId && !belongsToPendingTurn) return;

    let messages = this.snapshot.messages;
    let nextPendingTurn = pendingTurn;
    if (isPendingUser && pendingTurn) {
      nextPendingTurn = {
        ...pendingTurn,
        actualSessionId: message.sessionId
      };
      messages = messages.map((item) =>
        item.messageId === pendingTurn.assistantPlaceholderId
          ? { ...item, sessionId: message.sessionId }
          : item
      );
    }
    if (message.role === 'assistant') {
      messages = removeAssistantPlaceholder(
        messages,
        message.sessionId,
        pendingTurn?.assistantPlaceholderId
      );
      if (nextPendingTurn && belongsToPendingTurn) {
        nextPendingTurn = {
          ...nextPendingTurn,
          actualAssistantMessageId: message.messageId
        };
      }
    }
    this.pendingChatTurn = nextPendingTurn;
    this.update({
      messages: upsertBy(messages, message, 'messageId'),
      ...(isPendingUser && !this.snapshot.selectedSessionId
        ? { selectedSessionId: message.sessionId }
        : {})
    });
  }

  private setError(error: unknown): void {
    const message = runtimeRequestErrorMessage(error);
    const entry: TraceEntry = {
      traceId: `renderer-runtime-error:${crypto.randomUUID()}`,
      level: 'error',
      category: 'runtime.request.error',
      message,
      occurredAt: new Date().toISOString()
    };
    this.update({
      lastError: message,
      trace: [...this.snapshot.trace.slice(-499), entry]
    });
  }

  private applyStatus(status: RuntimeStatus): void {
    this.statusRevision += 1;
    this.update({ status });
  }

  private update(patch: Partial<RuntimeSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}

function mergeTraceEntries(
  current: readonly TraceEntry[],
  incoming: readonly TraceEntry[],
): TraceEntry[] {
  const entries = new Map<string, TraceEntry>();
  for (const entry of [...current, ...incoming]) entries.set(entry.traceId, entry);
  return [...entries.values()]
    .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt))
    .slice(-500);
}

export function runtimeRequestErrorMessage(
  error: unknown,
  fallback = 'Runtime 请求失败。'
): string {
  const source = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '';
  const message = source
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^(?:(?:RuntimeRequestError|Error):\s*)+/i, '')
    .trim();
  return (message || fallback).slice(0, 16_384);
}

export function useRuntimeSnapshot(store: RuntimeStore): RuntimeSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

function terminalActivityStatus(
  status: RunSummary['status']
): RunActivity['status'] | undefined {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled' || status === 'interrupted') return 'skipped';
  return undefined;
}

function upsertBy<T, K extends keyof T>(items: T[], item: T, key: K): T[] {
  const index = items.findIndex((candidate) => candidate[key] === item[key]);
  if (index < 0) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

function removeAssistantPlaceholder(
  messages: RuntimeMessage[],
  sessionId: string,
  placeholderId?: string
): RuntimeMessage[] {
  return messages.filter((message) =>
    !(
      message.role === 'assistant'
      && message.status === 'streaming'
      && message.content.length === 0
      && (
        message.messageId === placeholderId
        || (
          message.messageId.startsWith('pending-assistant:')
          && message.sessionId === sessionId
        )
      )
    )
  );
}

function failPendingChatTurn(
  messages: RuntimeMessage[],
  pendingTurn: PendingChatTurn,
  errorMessage: string
): RuntimeMessage[] {
  const assistantMessageId = pendingTurn.actualAssistantMessageId
    ?? pendingTurn.assistantPlaceholderId;
  let assistantMessageFound = false;
  const failedMessages = messages.flatMap((message): RuntimeMessage[] => {
    if (
      message.messageId === pendingTurn.assistantPlaceholderId
      && assistantMessageId !== pendingTurn.assistantPlaceholderId
    ) {
      return [];
    }
    if (message.messageId === pendingTurn.clientMessageId) {
      return [{ ...message, deliveryState: 'failed' }];
    }
    if (message.messageId === assistantMessageId) {
      assistantMessageFound = true;
      return [{
        ...message,
        content: '未能开始回复。',
        status: 'failed',
        error: {
          code: 'RUNTIME_REQUEST_FAILED',
          message: errorMessage.slice(0, 2_048),
          retryable: true
        }
      }];
    }
    return [message];
  });
  if (assistantMessageFound) return failedMessages;
  return [
    ...failedMessages,
    {
      messageId: pendingTurn.assistantPlaceholderId,
      sessionId: pendingTurn.actualSessionId ?? pendingTurn.provisionalSessionId,
      role: 'assistant',
      content: '未能开始回复。',
      status: 'failed',
      createdAt: new Date().toISOString(),
      error: {
        code: 'RUNTIME_REQUEST_FAILED',
        message: errorMessage.slice(0, 2_048),
        retryable: true
      }
    }
  ];
}

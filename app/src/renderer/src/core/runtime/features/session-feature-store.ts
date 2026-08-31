import {
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  type ConversationMessageReferenceV3,
  type ConversationSession,
  type PublicSessionProjectionV3,
  type RuntimeResult
} from '@ariadne/protocol/public';
import type { RuntimeFeatureCommandGateway } from './runtime-feature-command-gateway';
import type { SnapshotSource } from './feature-snapshot-store';

export interface SessionFeatureSnapshot {
  readonly sessions: readonly ConversationSession[];
  readonly selectedSessionId: string | null;
  readonly planModeSessionIds: readonly string[];
}

export type ConversationSessionQueryItem = Extract<
  RuntimeResult,
  { readonly kind: 'conversation.sessions.query_result.v3' }
>['items'][number];

export type ResolvedConversationMessage = Extract<
  RuntimeResult,
  { readonly kind: 'conversation.message.resolved.v3' }
>;

export interface SessionFeatureHost {
  projectionSessions(): readonly PublicSessionProjectionV3[];
  selectSession(sessionId: string): void;
  clearSessionSelection(): void;
  isPlanModeEnabled(sessionId: string | null): boolean;
  setPlanModeEnabled(enabled: boolean, sessionId: string | null): void;
  publish(): void;
  synchronize(): Promise<void>;
}

export class SessionFeatureStore {
  constructor(
    private readonly gateway: RuntimeFeatureCommandGateway,
    private readonly host: SessionFeatureHost,
    readonly view: SnapshotSource<SessionFeatureSnapshot>
  ) {}

  async select(sessionId: string): Promise<void> {
    this.host.selectSession(sessionId);
    this.host.publish();
  }

  clearSelection(): void {
    this.host.clearSessionSelection();
    this.host.publish();
  }

  isPlanModeEnabled(sessionId: string | null): boolean {
    return this.host.isPlanModeEnabled(sessionId);
  }

  setPlanModeEnabled(enabled: boolean, sessionId: string | null): void {
    this.host.setPlanModeEnabled(enabled, sessionId);
    this.host.publish();
  }

  rename(session: ConversationSession, title: string): Promise<void> {
    return this.mutate(session, {
      kind: 'conversation.session.rename.v3',
      title: title.trim()
    });
  }

  archive(session: ConversationSession): Promise<void> {
    return this.mutate(session, { kind: 'conversation.session.archive.v3' });
  }

  restore(session: ConversationSession): Promise<void> {
    return this.mutate(session, { kind: 'conversation.session.restore.v3' });
  }

  async query(
    workspaceId: string,
    query: string,
    status: 'active' | 'archived' | 'all' = 'active',
    limit = 20
  ): Promise<readonly ConversationSessionQueryItem[]> {
    const result = await this.gateway.execute({
      kind: 'conversation.sessions.query.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      workspaceId,
      query,
      status,
      limit
    });
    if (result.kind !== 'conversation.sessions.query_result.v3') {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    return result.items;
  }

  async resolveMessage(
    reference: ConversationMessageReferenceV3
  ): Promise<ResolvedConversationMessage> {
    const result = await this.gateway.execute({
      kind: 'conversation.message.resolve.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      reference
    });
    if (result.kind !== 'conversation.message.resolved.v3') {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    return result;
  }

  async forkFromMessage(
    sourceSessionId: string,
    boundary: ConversationMessageReferenceV3
  ): Promise<string> {
    const source = this.host.projectionSessions().find(
      (session) => session.sessionId === sourceSessionId
    );
    if (source === undefined || boundary.sessionId !== source.sessionId) {
      throw new Error('conversation_fork_projection_missing');
    }
    const sessionId = crypto.randomUUID();
    const result = await this.gateway.execute({
      kind: 'conversation.session.fork.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      sessionId,
      sourceSessionId: source.sessionId,
      workspaceId: source.workspaceId,
      expectedSourceSessionVersion: source.version,
      boundary
    });
    if (
      result.kind !== 'conversation.session.forked.v3'
      || result.sessionId !== sessionId
      || result.sourceSessionId !== source.sessionId
    ) {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    this.host.selectSession(sessionId);
    this.host.publish();
    await this.host.synchronize();
    return sessionId;
  }

  private async mutate(
    session: ConversationSession,
    mutation:
      | { readonly kind: 'conversation.session.rename.v3'; readonly title: string }
      | { readonly kind: 'conversation.session.archive.v3' }
      | { readonly kind: 'conversation.session.restore.v3' }
  ): Promise<void> {
    const authoritative = this.host.projectionSessions().find(
      (candidate) => candidate.sessionId === session.sessionId
    );
    if (authoritative === undefined || authoritative.workspaceId !== session.workspaceId) {
      throw new Error('conversation_session_projection_missing');
    }
    const result = await this.gateway.execute({
      ...mutation,
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      sessionId: authoritative.sessionId,
      workspaceId: authoritative.workspaceId,
      expectedSessionVersion: authoritative.version
    });
    if (
      result.kind !== 'conversation.session.updated.v3'
      || result.sessionId !== authoritative.sessionId
      || result.version !== authoritative.version + 1
    ) {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    void this.host.synchronize();
  }
}

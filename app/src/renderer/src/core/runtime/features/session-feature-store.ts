import {
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  canonicalPublicProjectionJson,
  type ConversationMessageReference,
  type ConversationSession,
  type PublicSessionProjection,
  type RuntimeResult
} from '@ariadne/protocol/public';
import type { RuntimeFeatureCommandGateway } from './runtime-feature-command-gateway';
import type { SnapshotSource } from './feature-snapshot-store';
import type { SessionFeatureSnapshot } from './projection-feature-snapshots';
export type { SessionFeatureSnapshot } from './projection-feature-snapshots';
import { ProjectionFeatureNavigation } from './projection-feature-navigation';

export type ConversationSessionQueryItem = Extract<
  RuntimeResult,
  { readonly kind: 'conversation.sessions.query_result' }
>['items'][number];

export type ResolvedConversationMessage = Extract<
  RuntimeResult,
  { readonly kind: 'conversation.message.resolved' }
>;

export interface SessionFeatureHost {
  projectionSessions(): readonly PublicSessionProjection[];
  resolveSession(sessionId: string): Promise<PublicSessionProjection | null>;
  selectSession(sessionId: string): void;
  clearSessionSelection(): void;
  isPlanModeEnabled(sessionId: string | null): boolean;
  setPlanModeEnabled(enabled: boolean, sessionId: string | null): void;
  publish(): void;
  synchronize(): Promise<void>;
}

export class SessionFeatureStore extends ProjectionFeatureNavigation {
  constructor(
    private readonly gateway: RuntimeFeatureCommandGateway,
    private readonly host: SessionFeatureHost,
    readonly view: SnapshotSource<SessionFeatureSnapshot>,
    navigateDirectory?: (direction: 'next' | 'previous') => Promise<void>
  ) { super(navigateDirectory); }

  async select(sessionId: string): Promise<void> {
    this.host.selectSession(sessionId);
    this.host.publish();
    await this.host.synchronize();
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
      kind: 'conversation.session.rename',
      title: title.trim()
    });
  }

  archive(session: ConversationSession): Promise<void> {
    return this.mutate(session, { kind: 'conversation.session.archive' });
  }

  restore(session: ConversationSession): Promise<void> {
    return this.mutate(session, { kind: 'conversation.session.restore' });
  }

  async query(
    workspaceId: string,
    query: string,
    status: 'active' | 'archived' | 'all' = 'active',
    limit = 20
  ): Promise<readonly ConversationSessionQueryItem[]> {
    const result = await this.gateway.execute({
      kind: 'conversation.sessions.query',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      workspaceId,
      query,
      status,
      limit
    });
    if (result.kind !== 'conversation.sessions.query_result') {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    return result.items;
  }

  async resolveMessage(
    reference: ConversationMessageReference
  ): Promise<ResolvedConversationMessage> {
    const result = await this.gateway.execute({
      kind: 'conversation.message.resolve',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      reference
    });
    if (result.kind !== 'conversation.message.resolved'
      || canonicalPublicProjectionJson(result.reference) !== canonicalPublicProjectionJson(reference)) {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    return result;
  }

  async forkFromMessage(
    sourceSessionId: string,
    boundary: ConversationMessageReference
  ): Promise<string> {
    const source = await this.host.resolveSession(sourceSessionId);
    if (source === null || boundary.sessionId !== source.sessionId) {
      throw new Error('conversation_fork_projection_missing');
    }
    const sessionId = crypto.randomUUID();
    const result = await this.gateway.execute({
      kind: 'conversation.session.fork',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      sessionId,
      sourceSessionId: source.sessionId,
      workspaceId: source.workspaceId,
      expectedSourceSessionVersion: source.version,
      boundary
    });
    if (
      result.kind !== 'conversation.session.forked'
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
      | { readonly kind: 'conversation.session.rename'; readonly title: string }
      | { readonly kind: 'conversation.session.archive' }
      | { readonly kind: 'conversation.session.restore' }
  ): Promise<void> {
    const authoritative = await this.host.resolveSession(session.sessionId);
    if (authoritative === null || authoritative.sessionId !== session.sessionId || authoritative.workspaceId !== session.workspaceId) {
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
      result.kind !== 'conversation.session.updated'
      || result.sessionId !== authoritative.sessionId
      || result.version !== authoritative.version + 1
    ) {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    void this.host.synchronize();
  }
}

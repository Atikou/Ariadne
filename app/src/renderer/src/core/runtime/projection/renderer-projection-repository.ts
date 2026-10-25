import {
  PUBLIC_PROJECTION_GENESIS_DIGEST, canonicalPublicProjectionJson, publicProjectionCatalogRow,
  type PublicProjectionChange, type PublicProjectionScope, type PublicProjectionMessageWindow,
  type PublicProjectionCatalogManifest, type PublicRunCatalogSummary, type PublicDecisionCatalogSummary,
  type PublicSessionProjection, type PublicDecisionProjection,
  messageMetadataOf, type PublicMessageMetadataWindowResult
} from '@ariadne/protocol/public';
import { ProjectionCatalogRepository, type ProjectionCatalogSelection, type ProjectionCatalogWindow } from './projection-catalog-repository';
import { ProjectionScopeRepository } from './projection-scope-repository';
import { ProjectionConversationRepository, type ProjectionConversationSnapshot } from './projection-conversation-repository';
import { ProjectionRunDocumentRepository } from './projection-run-document-repository';
import { projectionRunPresentation } from './projection-run-presentation';
import { observeProjectionInboxProofs } from './projection-inbox-proof-reader';
import type { VerifiedAgentInboxIdentity } from '../agent-input-delivery';
import { ProjectionRuntimeClient, ProjectionCatalogResetSignal, ProjectionSnapshotResetSignal, ProjectionScopedReadResetSignal, ProjectionProtocolIntegrityError } from './projection-runtime-client';
import type { ProjectionPresentation, ProjectionRun } from './projection-presentation';

export const SESSION_DIRECTORY: ProjectionCatalogSelection = { scope: { kind: 'directory' }, feature: 'sessions', filter: 'all' };
export const RUN_DIRECTORY: ProjectionCatalogSelection = { scope: { kind: 'tasks' }, feature: 'runs', filter: 'all' };
export const DECISION_DIRECTORY: ProjectionCatalogSelection = { scope: { kind: 'decisions' }, feature: 'decisions', filter: 'pending' };
const DIRECTORY_FEATURES = ['diagnostics', 'models'] as const;
const DIRECTORY_SCOPE: PublicProjectionScope = { kind: 'directory' };
const MAX_DETAILS = 16, MAX_DETAIL_BYTES = 8 * 1024 * 1024;

export interface RendererProjectionSnapshot extends ProjectionPresentation {
  readonly runSummaries: readonly PublicRunCatalogSummary[];
  readonly decisionSummaries: readonly PublicDecisionCatalogSummary[];
  readonly directory: ProjectionCatalogWindow | null;
  readonly taskDirectory: ProjectionCatalogWindow | null;
  readonly decisionDirectory: ProjectionCatalogWindow | null;
  readonly sessionRuns: ProjectionCatalogWindow | null;
  readonly sessionDecisions: ProjectionCatalogWindow | null;
  readonly messageWindow: Extract<PublicMessageMetadataWindowResult, { status: 'ok' }> | null;
  readonly conversationRange: ProjectionConversationSnapshot | null;
  readonly openedRunId: string | null;
  readonly openedDecisionId: string | null;
  readonly runDocumentManifest: PublicProjectionCatalogManifest | null;
}
type DetailChange = Extract<PublicProjectionChange, { feature: 'decisions' }>;
interface Detail { readonly change: DetailChange; readonly bytes: number }

/** Renderer composition of independent, bounded read ranges. Published Run and
 * Decision bodies are genuine explicit details, never fabricated summaries. */
export class RendererProjectionRepository {
  readonly catalogs: ProjectionCatalogRepository;
  readonly scopes: ProjectionScopeRepository;
  readonly conversations: ProjectionConversationRepository;
  readonly runDocuments: ProjectionRunDocumentRepository;
  private readonly listeners = new Set<() => void>();
  private readonly details = new Map<string, Detail>();
  private generation = 0;
  private viewGeneration = 0;
  private desiredSessionId: string | null = null;
  private resetEpoch = 0;
  private integrityError: string | null = null;
  private selectedSession: PublicSessionProjection | null = null;
  private selectedRunId: string | null = null;
  private selectedDecisionId: string | null = null;
  private visibleRunIds: readonly string[] = [];
  private visibleRunManifest: PublicProjectionCatalogManifest | null = null;
  private messageDescriptor: PublicProjectionMessageWindow = { kind: 'latest', limit: 64 };
  private snapshot: RendererProjectionSnapshot = this.empty();

  constructor(private readonly client: ProjectionRuntimeClient) {
    this.catalogs = new ProjectionCatalogRepository(client);
    this.scopes = new ProjectionScopeRepository(client);
    this.conversations = new ProjectionConversationRepository(client);
    this.runDocuments = new ProjectionRunDocumentRepository(client, this.conversations.bodies);
    this.catalogs.select(SESSION_DIRECTORY);
  }
  getSnapshot = (): RendererProjectionSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  resetLifecycle(): void { this.invalidate(); }
  clearForRuntimeReset(): void { this.invalidate(); }
  resetReadRanges(): void {
    this.generation += 1; this.viewGeneration += 1;
    this.catalogs.invalidate(); this.catalogs.select(SESSION_DIRECTORY);
    this.scopes.invalidate(); this.conversations.invalidate(); this.runDocuments.invalidate(); this.details.clear();
  }
  lockIntegrity(code: string): void {
    this.resetReadRanges(); this.integrityError = `projection_integrity_error:${code}`;
    this.snapshot = freeze({ ...this.snapshot, integrityError: this.integrityError }); this.publish();
  }
  private requireIntegrity(): void {
    if (this.integrityError !== null) throw new Error(this.integrityError);
  }
  private invalidate(): void {
    this.generation += 1; this.resetEpoch += 1; this.integrityError = null;
    this.catalogs.invalidate(); this.scopes.invalidate(); this.conversations.invalidate(); this.runDocuments.invalidate(); this.details.clear();
    this.viewGeneration += 1; this.desiredSessionId = null;
    this.selectedSession = null; this.selectedRunId = null; this.selectedDecisionId = null; this.messageDescriptor = { kind: 'latest', limit: 64 };
    this.visibleRunIds = []; this.visibleRunManifest = null;
    this.snapshot = this.empty(); this.publish();
  }

  selectSession(sessionId: string | null): void {
    if (this.desiredSessionId === sessionId) return;
    this.viewGeneration += 1; this.desiredSessionId = sessionId; this.selectedSession = null;
    this.selectedRunId = null; this.selectedDecisionId = null; this.details.clear();
    this.visibleRunIds = []; this.visibleRunManifest = null; this.runDocuments.unpin();
    this.conversations.select(null);
    this.messageDescriptor = { kind: 'latest', limit: 64 };
    this.snapshot = freeze({ ...this.snapshot, messages: [], runs: [], decisions: [], inferenceStreams: [],
      sessionRuns: null, sessionDecisions: null, messageWindow: null, conversationRange: null, openedRunId: null, openedDecisionId: null, runDocumentManifest: null });
    this.publish();
  }

  async synchronize(sessionId: string | null, force = false): Promise<void> {
    this.requireIntegrity();
    this.selectSession(sessionId);
    const generation = this.generation, view = this.viewGeneration;
    const current = () => generation === this.generation && view === this.viewGeneration;
    try {
      for (const selection of [SESSION_DIRECTORY, RUN_DIRECTORY, DECISION_DIRECTORY]) {
        await this.synchronizeCatalog(selection, force);
        if (!current()) return;
      }
      await this.synchronizeScope(DIRECTORY_SCOPE, DIRECTORY_FEATURES, undefined, force);
      if (!current()) return;
      if (sessionId !== this.selectedSession?.sessionId) {
        const resolved = sessionId === null ? null : await this.resolveSession(sessionId);
        if (!current()) return;
        this.selectedSession = resolved;
      } else if (sessionId !== null) {
        const resolved = await this.resolveSession(sessionId);
        if (!current()) return;
        this.selectedSession = resolved;
      }
      const session = this.selectedSession;
      if (session !== null) {
        const scope = sessionScope(session);
        const runs = sessionSelection(scope, 'runs'), decisions = sessionSelection(scope, 'decisions');
        await this.synchronizeCatalog(runs, force);
        if (!current()) return;
        await this.synchronizeCatalog(decisions, force);
        if (!current()) return;
        this.conversations.select(scope);
        await this.synchronizeConversation(scope, force);
        if (!current()) return;
        await this.loadVisibleDetails(scope, current);
        if (!current()) return;
      } else { this.details.clear(); this.visibleRunIds = []; this.visibleRunManifest = null; this.runDocuments.unpin(); }
      this.rebuild();
    } catch (error) {
      if (!current()) return;
      if (error instanceof ProjectionCatalogResetSignal || error instanceof ProjectionSnapshotResetSignal || error instanceof ProjectionScopedReadResetSignal) {
        // The caller explicitly starts a new synchronization generation. Reset
        // is not treated as an empty list or as a consumed unknown interval.
        throw error;
      }
      throw error;
    }
  }

  private async synchronizeCatalog(selection: ProjectionCatalogSelection, force: boolean): Promise<void> {
    if (force || this.catalogs.read(selection) === null) { await this.catalogs.load(selection); return; }
    let more = true;
    while (more) {
      let scan;
      try { scan = await this.catalogs.scan(selection); }
      catch (error) {
        if (!(error instanceof ProjectionSnapshotResetSignal || error instanceof ProjectionCatalogResetSignal)
          || error.reason !== 'snapshot_expired') throw error;
        await this.catalogs.load(selection); return;
      }
      if (scan.status === 'superseded') return;
      more = scan.hasMore;
      if (scan.dirty) { await this.catalogs.load(selection); return; }
    }
  }
  private async synchronizeScope(scope: PublicProjectionScope, features: readonly ('diagnostics' | 'models' | 'inference_streams')[],
    window: PublicProjectionMessageWindow | undefined, force: boolean): Promise<void> {
    if (force || this.scopes.read(scope, features) === null) { await this.scopes.loadBounded(scope, features, window); return; }
    let more = true;
    while (more) {
      let scan;
      try { scan = await this.scopes.scan(scope, features); }
      catch (error) {
        if (!(error instanceof ProjectionSnapshotResetSignal) || error.reason !== 'snapshot_expired') throw error;
        await this.scopes.loadBounded(scope, features, window); return;
      }
      if (scan.status === 'superseded') return;
      more = scan.hasMore;
      if (scan.dirty) { await this.scopes.loadBounded(scope, features, window); return; }
    }
  }

  private async resolveSession(sessionId: string): Promise<PublicSessionProjection | null> {
    const directory = this.catalogs.read(SESSION_DIRECTORY);
    if (directory === null) throw new Error('projection_session_directory_required');
    const visible = directory.page.rows.find(row => row.feature === 'sessions' && row.dto.sessionId === sessionId);
    if (visible?.feature === 'sessions') return visible.dto;
    const result = await this.client.readCatalogDetail(directory.page.manifest, sessionId);
    if (result.status !== 'ok') throw new ProjectionCatalogResetSignal(result.reason);
    return result.change?.feature === 'sessions' && result.change.operation === 'upsert' ? result.change.dto : null;
  }

  private async synchronizeConversation(scope: Extract<PublicProjectionScope, { kind: 'session' }>, force: boolean): Promise<void> {
    if (force || this.conversations.read(scope) === null) { await this.conversations.load(scope, this.messageDescriptor); return; }
    let more = true;
    while (more) {
      let scan;
      try { scan = await this.conversations.scan(scope); }
      catch (error) {
        if (!(error instanceof ProjectionCatalogResetSignal) || error.reason !== 'snapshot_expired') throw error;
        await this.conversations.load(scope, this.messageDescriptor); return;
      }
      if (scan.status === 'superseded') return;
      more = scan.hasMore;
      if (scan.dirty) { await this.conversations.load(scope, this.messageDescriptor); return; }
    }
  }

  private async loadVisibleDetails(scope: Extract<PublicProjectionScope, { kind: 'session' }>, current: () => boolean,
    chosenRunId = this.selectedRunId, chosenDecisionId = this.selectedDecisionId): Promise<void> {
    const runs = this.catalogs.read(sessionSelection(scope, 'runs'));
    const decisions = this.catalogs.read(sessionSelection(scope, 'decisions'));
    if (runs === null || decisions === null) throw new Error('projection_session_catalog_required');
    const rows = runs.page.rows.filter(row => row.feature === 'runs');
    const primary = rows.find(row => row.dto.parentRunId === undefined);
    const chosenRun = chosenRunId ?? primary?.dto.runId;
    const next = new Map<string, Detail>();
    const nextRunIds: string[] = [];
    const runIds = [...new Set([primary?.dto.runId, chosenRun].filter((id): id is string => id !== undefined))];
    const pins = this.runDocuments.stagePins(runs.page.manifest, runIds);
    try {
      for (const runId of runIds) {
        let document = this.runDocuments.read(runs.page.manifest, runId);
        if (document === null) {
          const loaded = await this.runDocuments.load(runs.page.manifest, runId, rows.find(row => row.dto.runId === runId)?.dto.version);
          if (!current()) return;
          if (loaded.status !== 'published') continue;
          document = loaded.snapshot;
        }
        const summary = rows.find(row => row.dto.runId === runId)?.dto;
        if (summary !== undefined && canonicalPublicProjectionJson(summary) !== canonicalPublicProjectionJson(document.root.header.summary)) {
          throw new ProjectionProtocolIntegrityError('projection_run_catalog_root_mismatch');
        }
        for (const collection of ['toolActivities', 'inbox'] as const) {
          if (document.root.header.collections[collection].itemCount > 0 && document.windows[collection] === undefined) {
            const loaded = await this.runDocuments.loadCollection(runs.page.manifest, runId, collection);
            if (!current()) return;
            if (loaded.status !== 'published') break;
            document = loaded.snapshot;
          }
        }
        if (!current()) return;
        nextRunIds.push(runId);
      }
      const candidates = decisions.page.rows.filter(row => row.feature === 'decisions');
      // Recovery/Budget for the opened Run must stay actionable. Other cards are
      // explicit bounded details; undisplayed pending rows remain in the catalog.
      const wanted = [...candidates.filter(row => row.dto.runId === chosenRun && ['recovery', 'budget'].includes(row.dto.kind)), ...candidates]
        .filter((row, index, all) => all.findIndex(item => item.dto.decisionId === row.dto.decisionId) === index).slice(0, 8);
      const decisionIds = new Set(wanted.map(row => row.dto.decisionId));
      if (chosenDecisionId !== null) decisionIds.add(chosenDecisionId);
      for (const id of decisionIds) {
        const change = await this.fetchDetail(decisions.page.manifest, id);
        if (!current()) return;
        if (change !== null) next.set(`decisions\u0000${id}`, this.detail(change));
      }
      this.replaceDetails(next);
      if (!pins.commit()) return;
      this.visibleRunManifest = runs.page.manifest; this.visibleRunIds = nextRunIds;
    } finally { pins.release(); }
  }
  private async fetchDetail(manifest: PublicProjectionCatalogManifest, id: string): Promise<DetailChange | null> {
    const result = await this.client.readCatalogDetail(manifest, id);
    if (result.status !== 'ok') throw new ProjectionCatalogResetSignal(result.reason);
    if (result.change === null || result.change.operation === 'delete') return null;
    if (result.change.feature !== 'decisions') throw new Error('projection_detail_feature_invalid');
    return freeze(result.change);
  }
  private detail(change: DetailChange): Detail {
    return { change, bytes: new TextEncoder().encode(canonicalPublicProjectionJson(change)).byteLength };
  }
  private replaceDetails(next: ReadonlyMap<string, Detail>): void {
    if (next.size > MAX_DETAILS || [...next.values()].reduce((sum, item) => sum + item.bytes, 0) > MAX_DETAIL_BYTES) {
      throw new Error('projection_detail_cache_capacity_exceeded');
    }
    this.details.clear(); for (const [entryKey, detail] of next) this.details.set(entryKey, detail);
  }

  async openRun(runId: string): Promise<void> {
    this.requireIntegrity();
    if (this.selectedSession === null) throw new Error('projection_run_session_required');
    this.viewGeneration += 1;
    const generation = this.generation, view = this.viewGeneration;
    const current = () => generation === this.generation && view === this.viewGeneration;
    const scope = sessionScope(this.selectedSession), selection = sessionSelection(scope, 'runs');
    await this.synchronizeCatalog(selection, true);
    if (!current()) return;
    await this.loadVisibleDetails(scope, current, runId);
    if (!current()) return;
    if (!this.visibleRunIds.includes(runId)) throw new Error('projection_run_detail_unavailable');
    this.selectedRunId = runId; this.rebuild();
  }
  async openDecision(decisionId: string): Promise<void> {
    this.requireIntegrity();
    if (this.selectedSession === null) throw new Error('projection_decision_session_required');
    // An explicit reopen is a new focus request even if this Decision is already
    // visible in another panel. Publish selection again after the scoped read.
    this.selectedDecisionId = null; this.rebuild();
    this.viewGeneration += 1;
    const generation = this.generation, view = this.viewGeneration;
    const current = () => generation === this.generation && view === this.viewGeneration;
    const scope = sessionScope(this.selectedSession), selection = sessionSelection(scope, 'decisions');
    await this.synchronizeCatalog(selection, true);
    if (!current()) return;
    await this.loadVisibleDetails(scope, current, this.selectedRunId, decisionId);
    if (!current()) return;
    this.selectedDecisionId = decisionId; this.rebuild();
  }
  async readSessionProof(sessionId: string): Promise<PublicSessionProjection | null> {
    this.requireIntegrity();
    const generation = this.generation;
    const manifest = await this.client.beginCatalog(SESSION_DIRECTORY);
    const result = await this.client.readCatalogDetail(manifest, sessionId);
    if (generation !== this.generation) throw new Error('projection_session_read_superseded');
    if (result.status !== 'ok') throw new ProjectionCatalogResetSignal(result.reason);
    return result.change?.feature === 'sessions' && result.change.operation === 'upsert' ? result.change.dto : null;
  }
  async observeInboxProofs(references: readonly { readonly runId: string; readonly sessionId: string; readonly inputId: string }[],
    observer: (identity: VerifiedAgentInboxIdentity) => void): Promise<void> {
    this.requireIntegrity();
    const generation = this.generation;
    await observeProjectionInboxProofs(this.client, this.runDocuments, references, id => this.readSessionProof(id),
      () => generation === this.generation, () => this.snapshot.streamId, observer);
  }
  async decisionSettled(decisionId: string): Promise<boolean> {
    this.requireIntegrity();
    const manifest = await this.client.beginCatalog(DECISION_DIRECTORY);
    const result = await this.client.readCatalogDetail(manifest, decisionId);
    if (result.status !== 'ok') throw new ProjectionCatalogResetSignal(result.reason);
    return result.change === null || result.change.operation === 'delete'
      || (result.change.feature === 'decisions' && result.change.dto?.status !== 'pending');
  }
  async messageWindow(descriptor: PublicProjectionMessageWindow): Promise<void> {
    this.requireIntegrity();
    if (this.selectedSession === null) throw new Error('projection_message_session_required');
    this.viewGeneration += 1;
    const generation = this.generation, view = this.viewGeneration;
    const scope = sessionScope(this.selectedSession);
    const result = descriptor.kind === 'latest' ? await this.conversations.load(scope, descriptor)
      : await this.conversations.navigate(scope, descriptor);
    if (generation !== this.generation || view !== this.viewGeneration || result.status !== 'published') return;
    this.messageDescriptor = freeze({ ...descriptor }); this.rebuild();
  }
  async loadMessageBody(messageId: string, sessionId: string, windowDigest: string): Promise<void> {
    this.requireIntegrity();
    const session = this.selectedSession; if (session?.sessionId !== sessionId) return;
    const scope = sessionScope(session), range = this.conversations.read(scope);
    if (range?.messages.windowDigest !== windowDigest) return;
    const generation = this.generation, view = this.viewGeneration;
    let result;
    try { result = await this.conversations.loadBody(scope, messageId); }
    catch (error) {
      if (error instanceof ProjectionProtocolIntegrityError) this.lockIntegrity(error.integrityCode);
      if (error instanceof ProjectionCatalogResetSignal && error.reason === 'snapshot_expired'
        && generation === this.generation && view === this.viewGeneration) {
        const renewed = await this.conversations.load(scope, this.messageDescriptor);
        if (generation !== this.generation || view !== this.viewGeneration) return;
        if (renewed.status === 'published') { this.rebuild(); return; }
      }
      throw error;
    }
    if (generation !== this.generation || view !== this.viewGeneration || result.status !== 'loaded') return;
    this.rebuild();
  }
  async readRunCollection(runId: string, sessionId: string, token: string, collection: 'toolActivities' | 'inbox', direction: 'first' | 'next'): Promise<void> {
    this.requireIntegrity();
    const manifest = this.runReadManifest(runId, sessionId, token); if (manifest === null) return;
    this.viewGeneration++; const generation = this.generation, view = this.viewGeneration;
    try {
      const result = await (direction === 'first' ? this.runDocuments.loadCollection(manifest, runId, collection)
        : this.runDocuments.nextCollectionPage(manifest, runId, collection));
      if (generation === this.generation && view === this.viewGeneration && result.status === 'published') this.rebuild();
    } catch (error) { await this.runReadFailure(error, sessionId, generation, view); }
  }
  async loadInboxBody(runId: string, sessionId: string, inputId: string, token: string): Promise<void> {
    this.requireIntegrity();
    const manifest = this.runReadManifest(runId, sessionId, token); if (manifest === null) return;
    const generation = this.generation, view = this.viewGeneration;
    try {
      const result = await this.runDocuments.loadBody(manifest, runId, 'inbox', inputId);
      if (generation === this.generation && view === this.viewGeneration && result.status === 'loaded') this.rebuild();
    } catch (error) { await this.runReadFailure(error, sessionId, generation, view); }
  }
  private runReadManifest(runId: string, sessionId: string, token: string): PublicProjectionCatalogManifest | null {
    if (this.selectedSession?.sessionId !== sessionId || !this.snapshot.runs.some(run => run.runId === runId && run.documentToken === token)) return null;
    return this.snapshot.runDocumentManifest;
  }
  private async runReadFailure(error: unknown, sessionId: string, generation: number, view: number): Promise<void> {
    if (generation !== this.generation || view !== this.viewGeneration) return;
    if (error instanceof ProjectionProtocolIntegrityError) this.lockIntegrity(error.integrityCode);
    if (error instanceof ProjectionCatalogResetSignal && error.reason === 'snapshot_expired') {
      await this.synchronize(sessionId, true); return;
    }
    throw error;
  }
  async navigate(selection: ProjectionCatalogSelection, direction: 'next' | 'previous'): Promise<void> {
    this.requireIntegrity();
    const generation = this.generation;
    await (direction === 'next' ? this.catalogs.next(selection) : this.catalogs.previous(selection));
    if (generation === this.generation) this.rebuild();
  }
  async navigateSession(feature: 'runs' | 'decisions', direction: 'next' | 'previous'): Promise<void> {
    this.requireIntegrity();
    if (this.selectedSession === null) throw new Error('projection_session_required');
    const generation = this.generation, view = this.viewGeneration;
    const selection = sessionSelection(sessionScope(this.selectedSession), feature);
    await (direction === 'next' ? this.catalogs.next(selection) : this.catalogs.previous(selection));
    if (generation === this.generation && view === this.viewGeneration) this.rebuild();
  }

  private rebuild(): void {
    const directory = this.catalogs.read(SESSION_DIRECTORY), taskDirectory = this.catalogs.read(RUN_DIRECTORY), decisionDirectory = this.catalogs.read(DECISION_DIRECTORY);
    const catalogWindows = [directory, taskDirectory, decisionDirectory].filter(window => window !== null);
    const streamId = directory?.page.manifest.streamId ?? null;
    if (catalogWindows.some(window => window.page.manifest.streamId !== streamId)) throw new ProjectionCatalogResetSignal('stream_mismatch');
    const directoryScope = this.scopes.read(DIRECTORY_SCOPE, DIRECTORY_FEATURES);
    const selectedScope = this.selectedSession === null ? null : sessionScope(this.selectedSession);
    const selected = selectedScope === null ? null : this.conversations.read(selectedScope);
    const sessionRuns = selectedScope === null ? null : this.catalogs.read(sessionSelection(selectedScope, 'runs'));
    const sessionDecisions = selectedScope === null ? null : this.catalogs.read(sessionSelection(selectedScope, 'decisions'));
    if ([directoryScope, selected].some(scope => scope !== null && scope.manifest.streamId !== streamId)
      || [sessionRuns, sessionDecisions].some(window => window !== null && window.page.manifest.streamId !== streamId)) {
      throw new ProjectionCatalogResetSignal('stream_mismatch');
    }
    const sessions = directory?.page.rows.flatMap(row => row.feature === 'sessions' ? [row.dto] : []) ?? [];
    if (this.selectedSession !== null && !sessions.some(session => session.sessionId === this.selectedSession?.sessionId)) sessions.push(this.selectedSession);
    const runDetails: ProjectionRun[] = [], decisionDetails: PublicDecisionProjection[] = [];
    if (this.visibleRunManifest !== null) for (const id of this.visibleRunIds) {
      const document = this.runDocuments.read(this.visibleRunManifest, id);
      if (document !== null && document.root.header.summary.sessionId === this.selectedSession?.sessionId) {
        runDetails.push(projectionRunPresentation(document, this.conversations.bodies));
      }
    }
    for (const detail of this.details.values()) {
      const { change } = detail;
      if (change.dto === null || change.dto.sessionId !== this.selectedSession?.sessionId) continue;
      decisionDetails.push(change.dto);
    }
    const runs = new Map<string, PublicRunCatalogSummary>();
    const decisions = new Map<string, PublicDecisionCatalogSummary>();
    for (const window of [taskDirectory, sessionRuns]) for (const row of window?.page.rows ?? []) if (row.feature === 'runs') runs.set(row.dto.runId, row.dto);
    for (const window of [decisionDirectory, sessionDecisions]) for (const row of window?.page.rows ?? []) if (row.feature === 'decisions') decisions.set(row.dto.decisionId, row.dto);
    for (const detail of this.details.values()) {
      if (detail.change.dto === null) continue;
      const row = publicProjectionCatalogRow(detail.change);
      if (row.feature === 'decisions') decisions.set(row.dto.decisionId, row.dto);
    }
    for (const run of runDetails) {
      const { documentToken: _token, collections: _collections, toolActivities: _tools, inbox: _inbox, ...summary } = run;
      runs.set(run.runId, summary);
    }
    const globals = directoryScope?.changes ?? [];
    const messages = selected?.messages.rows.map(row => {
      const metadata = messageMetadataOf(row), body = this.conversations.bodies.readMessage(selected.manifest, row);
      const content = body?.kind === 'message' ? body.message.content
        : body?.kind === 'document_item' && body.item.collection === 'interactionMessages' ? body.item.value.content : undefined;
      return { ...metadata, bodyState: content === undefined ? 'unloaded' as const : 'loaded' as const,
        bodyReadToken: selected.messages.windowDigest, ...(content === undefined ? {} : { content }) };
    }) ?? [];
    const prefixes = new Map<string, ProjectionPresentation['inferenceStreams'][number]>();
    for (const window of selected?.inferencePrefixes ?? []) for (const change of window.changes) {
      if (change.feature === 'inference_streams' && change.dto !== null) prefixes.set(change.aggregateId, change.dto);
    }
    // This cursor describes directory scanning only. Other ranges expose their
    // own manifest and watermark; no scalar claims all domains consumed it.
    const watermark = this.catalogs.watermark(SESSION_DIRECTORY);
    if (this.snapshot.streamId !== null && streamId !== this.snapshot.streamId) this.resetEpoch += 1;
    this.snapshot = freeze({ streamId, cursor: watermark?.cursor ?? 0, cursorDigest: watermark?.digest ?? PUBLIC_PROJECTION_GENESIS_DIGEST,
      resetEpoch: this.resetEpoch, integrityError: this.integrityError, sessions: retainSlice(this.snapshot.sessions, sessions),
      messages: retainSlice(this.snapshot.messages, messages),
      runs: retainSlice(this.snapshot.runs, runDetails), decisions: retainSlice(this.snapshot.decisions, decisionDetails),
      models: retainSlice(this.snapshot.models, globals.flatMap(change => change.feature === 'models' && change.dto !== null ? [change.dto] : [])),
      diagnostics: retainSlice(this.snapshot.diagnostics, globals.flatMap(change => change.feature === 'diagnostics' && change.dto !== null ? [change.dto] : [])),
      inferenceStreams: retainSlice(this.snapshot.inferenceStreams, [...prefixes.values()]),
      runSummaries: retainSlice(this.snapshot.runSummaries, [...runs.values()]), decisionSummaries: retainSlice(this.snapshot.decisionSummaries, [...decisions.values()]), directory, taskDirectory, decisionDirectory,
      sessionRuns, sessionDecisions, messageWindow: selected?.messages ?? null, conversationRange: selected, openedRunId: this.selectedRunId, openedDecisionId: this.selectedDecisionId,
      runDocumentManifest: this.visibleRunManifest });
    this.publish();
  }
  private empty(): RendererProjectionSnapshot {
    return freeze({ streamId: null, cursor: 0, cursorDigest: PUBLIC_PROJECTION_GENESIS_DIGEST, resetEpoch: this.resetEpoch,
      integrityError: this.integrityError, sessions: [], messages: [], runs: [], decisions: [], models: [], diagnostics: [], inferenceStreams: [],
      runSummaries: [], decisionSummaries: [], directory: null, taskDirectory: null, decisionDirectory: null,
      sessionRuns: null, sessionDecisions: null, messageWindow: null, conversationRange: null, openedRunId: null, openedDecisionId: null, runDocumentManifest: null });
  }
  private publish(): void { for (const listener of this.listeners) listener(); }
}
/** Only the bounded current presentation participates; no historical DTO cache
 * is created. Verified equal bodies retain feature identity across new leases. */
function retainSlice<T>(previous: readonly T[], next: readonly T[]): readonly T[] {
  if (previous.length !== next.length) return next;
  return next.every((item, index) => item === previous[index]
    || canonicalPublicProjectionJson(item) === canonicalPublicProjectionJson(previous[index])) ? previous : next;
}
function sessionScope(session: PublicSessionProjection): Extract<PublicProjectionScope, { kind: 'session' }> {
  return { kind: 'session', workspaceId: session.workspaceId, sessionId: session.sessionId };
}
function sessionSelection(scope: Extract<PublicProjectionScope, { kind: 'session' }>, feature: 'runs' | 'decisions'): ProjectionCatalogSelection {
  return { scope, feature, filter: feature === 'decisions' ? 'pending' : 'all' };
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

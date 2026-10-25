import { randomUUID } from 'node:crypto';
import { setImmediate as yieldBatch } from 'node:timers/promises';
import { PUBLIC_PROJECTION_CATALOG_VERSION, taskSourceMetadataSchema,
  type PublicRunCatalogSummary, type PublicProjectionCatalogManifest,
  type PublicProjectionCatalogRow, type TaskDirectoryRow, type TaskSourceMetadata } from '@ariadne/protocol/public';
import type { AgentRun } from '@ariadne/agent-core';
import type { PublicProjectionCatalogQueryStoreV3 } from '../projection/PublicProjectionCatalogQueryPortsV3.js';
import type { SqliteConversationRunHandoffUnitOfWork } from '../adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import type { SqliteProductivityStore } from '../adapters/persistence/SqliteProductivityStore.js';
import type { SqliteTaskQuerySnapshotStore } from '../adapters/persistence/SqliteTaskQuerySnapshotStore.js';
import type { TaskSnapshotCoverage } from '../adapters/persistence/TaskQuerySnapshotRecords.js';
import type { ProductivityTaskReference } from '../control/ports/ProductivityTaskCatalogReadV1.js';
import { deriveConversationAuthorityId } from '../conversation/ConversationRunHandoffIds.js';
import { ScheduleExecutionFacts } from './ScheduleExecutionFacts.js';
import { readOwnedAuthorityFault } from '../adapters/persistence/SqliteAuthorityHealth.js';

export interface TaskCenterSources {
  readonly projection: PublicProjectionCatalogQueryStoreV3;
  readonly conversation: SqliteConversationRunHandoffUnitOfWork;
  readonly productivity?: SqliteProductivityStore;
  readonly index: SqliteTaskQuerySnapshotStore;
  readonly authorizedWorkspaceIds: readonly string[];
  readonly loadRun: (runId: string) => Promise<AgentRun | null>;
}

/** Background observation only. Caller cancellation cannot turn a submitted task into a result. */
export class TaskCenterSourceCollector {
  private readonly authorized: ReadonlySet<string>;
  private coverage: TaskSnapshotCoverage;
  constructor(private readonly sources: TaskCenterSources, private readonly now = () => new Date()) {
    this.authorized = new Set(sources.authorizedWorkspaceIds);
    this.coverage = ['projection', 'productivity', 'conversation'].map(source => ({
      source: source as TaskSnapshotCoverage[number]['source'], status: 'building', revision: null,
      capturedAt: now().toISOString(), diagnosticCode: null }));
  }
  watermarks(): TaskSnapshotCoverage { return this.coverage.map(mark => ({ ...mark })); }
  async collect(signal: AbortSignal): Promise<void> {
    for (const mark of this.coverage) this.setCoverage(mark.source, 'building', mark.revision, null);
    let conversationFailed = false;
    const session = async (sessionId: string | undefined) => {
      if (sessionId === undefined) return null;
      try {
        const owner = await this.sources.conversation.readSession(sessionId);
        signal.throwIfAborted();
        return owner && (this.authorized.size === 0 || this.authorized.has(owner.workspaceId)) ? owner : null;
      } catch (error) { signal.throwIfAborted(); conversationFailed = true; throw error; }
    };
    try {
      const tag = randomUUID();
      const decisions = await this.begin('decisions');
      await this.pages(decisions, signal, async rows => {
        const references: TaskDirectoryRow['decisions'] = [];
        for (const row of rows) {
          if (row.feature !== 'decisions') throw new Error('task_catalog_feature_mismatch');
          const owner = await session(row.dto.sessionId);
          if (owner) references.push({ workspaceId: owner.workspaceId, sessionId: owner.sessionId,
            runId: row.dto.runId, decisionId: row.dto.decisionId, version: row.dto.version, kind: row.dto.kind });
        }
        this.sources.index.mergeDecisions(tag, references);
      });
      this.sources.index.finishDecisions(tag);
      const runs = await this.begin('runs');
      // First pass gives every authorized parent a minimal row. The second joins exact parent ownership.
      const collectRuns = async () => this.pages(runs, signal, async rows => {
        const mapped: TaskDirectoryRow[] = [];
        for (const row of rows) {
          if (row.feature !== 'runs') throw new Error('task_catalog_feature_mismatch');
          const owner = await session(row.dto.sessionId);
          if (owner) mapped.push(await this.runRow(row.dto, owner.workspaceId, owner.status === 'archived', signal));
        }
        this.sources.index.mergeCurrent('run', tag, mapped);
      });
      await collectRuns(); this.sources.index.finishCurrent('run', tag); await collectRuns();
      this.setCoverage('projection', 'ready', Math.min(runs.boundaryCursor, decisions.boundaryCursor), null);
    } catch (error) {
      signal.throwIfAborted();
      if (readOwnedAuthorityFault(error)?.source === 'conversation') conversationFailed = true;
      this.setCoverage('projection', 'unavailable', null, 'task_projection_read_failed');
    }
    const store = this.sources.productivity;
    if (store === undefined) this.setCoverage('productivity', 'unavailable', null, 'task_productivity_not_configured');
    else try {
      const tag = randomUUID(); let after: ProductivityTaskReference | null = null, revision = 0, joinsIncomplete = false;
      do {
        signal.throwIfAborted();
        const page = await store.readTaskCatalogPage({ workspaceIds: this.authorized.size ? [...this.authorized] : null,
          session: null }, after, 32);
        revision = page.eventCursor;
        const mapped: TaskDirectoryRow[] = [];
        for (const metadata of page.rows) {
          const owner = await session(metadata.sessionId);
          if (owner && owner.workspaceId === metadata.workspaceId) {
            try { mapped.push(await this.productivityRow(metadata, owner.status === 'archived', signal)); }
            catch (error) {
              signal.throwIfAborted();
              if (metadata.reference.source !== 'occurrence') throw error;
              if (readOwnedAuthorityFault(error)?.source === 'conversation') conversationFailed = true;
              joinsIncomplete = true;
              mapped.push({ metadata: { ...metadata, state: 'unknown', runReferences: [], runReferenceTotal: 0 },
                archived: owner.status === 'archived', decisions: [], result: 'unavailable' });
            }
          }
        }
        for (const source of ['goal', 'workflow', 'schedule', 'occurrence'] as const)
          this.sources.index.mergeCurrent(source, tag, mapped.filter(row => row.metadata.reference.source === source));
        after = page.next; await yieldBatch(undefined, { signal });
      } while (after !== null);
      for (const source of ['goal', 'workflow', 'schedule', 'occurrence'] as const) this.sources.index.finishCurrent(source, tag);
      this.setCoverage('productivity', joinsIncomplete ? 'unavailable' : 'ready', revision,
        joinsIncomplete ? 'task_execution_join_incomplete' : null);
    } catch (error) {
      signal.throwIfAborted();
      if (readOwnedAuthorityFault(error)?.source === 'conversation') conversationFailed = true;
      this.setCoverage('productivity', 'unavailable', null, 'task_productivity_read_failed');
    }
    this.setCoverage('conversation', conversationFailed ? 'unavailable' : 'ready', null,
      conversationFailed ? 'task_conversation_read_failed' : null);
  }
  private async begin(feature: 'runs' | 'decisions'): Promise<PublicProjectionCatalogManifest> {
    const result = await this.sources.projection.beginCatalogSnapshot({ pageContractVersion: PUBLIC_PROJECTION_CATALOG_VERSION,
      scope: { kind: feature === 'runs' ? 'tasks' : 'decisions' }, feature, filter: feature === 'runs' ? 'all' : 'pending' });
    if ('status' in result) throw new Error('task_projection_snapshot_reset');
    return result;
  }
  private async pages(manifest: PublicProjectionCatalogManifest, signal: AbortSignal,
    consume: (rows: PublicProjectionCatalogRow[]) => Promise<void>): Promise<void> {
    let cursor: string | undefined;
    do {
      signal.throwIfAborted();
      const page = await this.sources.projection.readCatalogPage({ manifest, limit: 32,
        ...(cursor === undefined ? {} : { pageCursor: cursor }) });
      if (page.status !== 'ok') throw new Error('task_projection_page_reset');
      await consume(page.rows); cursor = page.nextPageCursor; await yieldBatch(undefined, { signal });
    } while (cursor !== undefined);
  }
  private async runRow(run: PublicRunCatalogSummary, workspaceId: string, archived: boolean,
    signal: AbortSignal): Promise<TaskDirectoryRow> {
    if (run.sessionId === undefined) throw new Error('task_run_session_missing');
    const parent = run.parentRunId === undefined ? null : this.sources.index.currentItem({ source: 'run', sourceId: run.parentRunId });
    const relations: TaskSourceMetadata['relations'] = parent && parent.metadata.workspaceId === workspaceId
      ? [{ kind: 'parent', reference: parent.metadata.reference,
        owner: { workspaceId, sessionId: parent.metadata.sessionId } }] : [];
    const row: TaskDirectoryRow = { metadata: taskSourceMetadataSchema.parse({ reference: { source: 'run', sourceId: run.runId },
      workspaceId, sessionId: run.sessionId, title: run.title, sourceStatus: run.status,
      state: taskRunState(run.status, run.cancellationPending), version: run.version, attempts: null,
      updatedAt: run.updatedAt, dueAt: null, relations, relationTotal: relations.length,
      runReferences: [], runReferenceTotal: 0 }), archived,
      decisions: this.sources.index.currentDecisions(workspaceId, run.sessionId, run.runId), result: 'none' };
    if (['completed', 'failed', 'cancelled'].includes(run.status)) {
      row.result = 'unavailable';
      if (run.sourceMessageId !== undefined) {
        const saga = await this.sources.conversation.readSagaByMessage(run.sourceMessageId, 1);
        signal.throwIfAborted();
        if (saga && saga.workspaceId === workspaceId && saga.sessionId === run.sessionId) {
          row.result = 'pending';
          if (saga.stage.kind === 'agent_result_projected' && saga.stage.runId === run.runId
            && saga.stage.resultRunVersion === run.version && saga.stage.resultStatus === run.status) {
            const id = await deriveConversationAuthorityId('agent-result-message', saga.stage.sourceRunEventId);
            const identity = await this.sources.conversation.readMessageIdentity(id, 1);
            if (identity?.role === 'assistant' && identity.workspaceId === workspaceId && identity.reference.sessionId === run.sessionId)
              row.result = 'available';
          }
        }
      }
    }
    return row;
  }
  private async productivityRow(metadata: TaskSourceMetadata, archived: boolean, signal: AbortSignal): Promise<TaskDirectoryRow> {
    let result: TaskDirectoryRow['result'] = 'none';
    const decisions: TaskDirectoryRow['decisions'] = [];
    const runReferences: TaskSourceMetadata['runReferences'] = [];
    for (const reference of metadata.runReferences) {
      const actual = this.sources.index.currentItem({ source: 'run', sourceId: reference.runId });
      if (actual?.metadata.workspaceId === reference.workspaceId && actual.metadata.sessionId === reference.sessionId) {
        runReferences.push(reference); decisions.push(...actual.decisions);
      }
    }
    if (metadata.reference.source === 'occurrence' && this.sources.productivity !== undefined) {
      const fact = await new ScheduleExecutionFacts(this.sources.productivity, this.sources.conversation, this.sources.loadRun)
        .read(metadata.reference.sourceId, metadata.workspaceId, metadata.sessionId, metadata.sourceStatus === 'submitted', signal);
      if (fact) {
        metadata = { ...metadata, state: fact.status === 'start_failed' ? 'failed'
          : fact.status === 'handoff_pending' || fact.status === 'starting' ? 'queued'
            : fact.status === 'waiting' ? 'waiting_confirmation' : fact.status === 'waiting_input' ? 'paused'
              : fact.status === 'waiting_children' ? 'blocked' : fact.status };
        if (fact.runId !== null) {
          runReferences.push({ workspaceId: metadata.workspaceId, sessionId: metadata.sessionId, runId: fact.runId });
          decisions.push(...this.sources.index.currentDecisions(metadata.workspaceId, metadata.sessionId, fact.runId));
        }
        result = fact.resultReference !== null ? 'available' : fact.resultPending ? 'pending' : 'none';
      }
    }
    if (decisions.length > 128) throw new Error('task_query_decision_summary_incomplete');
    const relations = metadata.relations.filter(relation => relation.reference.source !== 'run'
      || runReferences.some(run => run.runId === relation.reference.sourceId
        && run.workspaceId === relation.owner.workspaceId && run.sessionId === relation.owner.sessionId));
    return { metadata: taskSourceMetadataSchema.parse({ ...metadata, relations, runReferences,
      runReferenceTotal: Math.max(metadata.runReferenceTotal, runReferences.length) }), archived,
      decisions: decisions.filter((item, index) => decisions.findIndex(other => other.decisionId === item.decisionId) === index), result };
  }
  private setCoverage(source: TaskSnapshotCoverage[number]['source'], status: TaskSnapshotCoverage[number]['status'],
    revision: number | null, diagnosticCode: string | null): void {
    this.coverage = this.coverage.map(mark => mark.source === source
      ? { source, status, revision, capturedAt: this.now().toISOString(), diagnosticCode } : mark);
  }
}

export function taskRunState(status: PublicRunCatalogSummary['status'], cancellationPending?: boolean): TaskSourceMetadata['state'] {
  if (status === 'running' && cancellationPending) return 'cancelling';
  if (['waiting_permission', 'waiting_decision', 'waiting_budget'].includes(status)) return 'waiting_confirmation';
  if (status === 'waiting_children') return 'blocked';
  if (status === 'interrupted') return 'recovering';
  return status as TaskSourceMetadata['state'];
}

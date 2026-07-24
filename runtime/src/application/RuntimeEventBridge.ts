import type { PermissionRequest, RuntimeEvent } from '@ariadne/protocol/public';

import type { AppContext } from '../app/createAppContext.js';
import type { TraceCatalog } from '../trace/traceCatalog.js';
import type { TraceEvent } from '../trace/TraceLogger.js';
import { scanTraceEvents } from '../trace/traceQuery.js';
import { toAbsoluteSegment } from '../trace/tracePaths.js';
import { readTraceSegmentUtf8 } from '../util/traceSegmentIo.js';
import { redactValue } from '../util/redact.js';
import {
  projectAgentProposal,
  projectPlanHandoff,
  projectRun,
  projectRunActivity,
  projectTraceEvent
} from './publicProjection.js';
import type { RuntimeEventSink } from './RuntimeFacade.js';
import type { PermissionRequestPayload } from '../policy/permissionRequestTypes.js';

const DEFAULT_POLL_INTERVAL_MS = 200;
const TRACE_WINDOW = 1_000;
const MAX_TRACKED_TRACE_IDS = TRACE_WINDOW * 2;

/**
 * Ariadne bridge from durable Runtime stores/trace to the public event protocol.
 * It observes domain state without adding callbacks or transport concepts to Agent core.
 */
export class RuntimeEventBridge {
  private readonly seenTraceIds = new BoundedCache<string, true>(MAX_TRACKED_TRACE_IDS);
  private readonly proposalIdByRunId = new BoundedCache<string, string>(MAX_TRACKED_TRACE_IDS);
  private permissionFingerprints = new Map<string, string>();
  private planFingerprints = new Map<string, string>();
  private readonly runFingerprints = new BoundedCache<string, string>(MAX_TRACKED_TRACE_IDS);
  private readonly traceCursor: IndexedTraceCursor | null;
  private timer?: NodeJS.Timeout;
  private flushing?: Promise<void>;
  private starting?: Promise<void>;
  private running = false;

  constructor(
    private readonly app: AppContext,
    private readonly emit: RuntimeEventSink,
    private readonly projectPermission: (request: PermissionRequestPayload) => PermissionRequest,
    private readonly pollIntervalMs = DEFAULT_POLL_INTERVAL_MS
  ) {
    this.traceCursor = IndexedTraceCursor.create(app.traceCatalog);
  }

  start(): Promise<void> {
    if (this.running) return this.starting ?? Promise.resolve();
    this.running = true;
    const operation = this.startNow()
      .catch((error) => {
        this.running = false;
        throw error;
      })
      .finally(() => {
        if (this.starting === operation) this.starting = undefined;
      });
    this.starting = operation;
    return operation;
  }

  private async startNow(): Promise<void> {
    await this.prime();
    if (!this.running) return;
    this.timer = setInterval(() => {
      void this.flush().catch(() => {
        // A later poll retries durable state; observation must not stop Runtime execution.
      });
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.starting?.catch(() => undefined);
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flushing?.catch(() => undefined);
  }

  flush(): Promise<void> {
    if (!this.flushing) {
      this.flushing = this.flushNow().finally(() => {
        this.flushing = undefined;
      });
    }
    return this.flushing;
  }

  async emitProposalForRun(runId: string): Promise<void> {
    let proposalId = this.proposalIdByRunId.get(runId);
    if (!proposalId) {
      const events = await scanTraceEvents(this.app.paths.traceFile, {
        limit: TRACE_WINDOW,
        redact: true,
        catalog: this.app.traceCatalog,
        filter: { runId, replayOnly: false }
      });
      for (const event of events) this.trackProposalLink(event);
      proposalId = this.proposalIdByRunId.get(runId);
    }
    if (!proposalId) return;
    const proposal = this.app.agentHandoffCoordinator.get(proposalId);
    if (proposal) this.emit({ kind: 'agent.proposal.changed', proposal: projectAgentProposal(proposal) });
  }

  private async prime(): Promise<void> {
    this.traceCursor?.prime();
    const events = await this.readTraceWindow();
    for (const event of events) {
      const id = traceId(event);
      if (!this.traceCursor && id) this.rememberTraceId(id);
      this.trackProposalLink(event);
    }
    this.permissionFingerprints = fingerprints(
      this.app.permissionRequestStore.listPending(),
      (request) => request.id
    );
    this.planFingerprints = fingerprints(
      this.app.planHandoffStore.listPending(),
      (handoff) => handoff.id
    );
  }

  private async flushNow(): Promise<void> {
    const events = this.traceCursor
      ? this.traceCursor.readNewEvents()
      : await this.readTraceWindow();
    for (const [index, event] of events.entries()) {
      this.trackProposalLink(event);
      const id = traceId(event);
      if (!id || !this.rememberTraceId(id)) continue;
      this.emit({ kind: 'trace.appended', entry: projectTraceEvent(event, `trace:${index}`) });
      const activity = projectRunActivity(event);
      if (activity) this.emit({ kind: 'run.activity', activity });
      this.emitRunChange(event);
    }
    this.emitPermissionChanges();
    this.emitPlanChanges();
  }

  private readTraceWindow(): Promise<TraceEvent[]> {
    return scanTraceEvents(this.app.paths.traceFile, {
      limit: TRACE_WINDOW,
      redact: true,
      catalog: this.app.traceCatalog,
      filter: { replayOnly: false }
    });
  }

  private emitPermissionChanges(): void {
    const pending = this.app.permissionRequestStore.listPending();
    const next = fingerprints(pending, (request) => request.id);
    for (const request of pending) {
      if (this.permissionFingerprints.get(request.id) !== next.get(request.id)) {
        this.emit({ kind: 'permission.changed', request: this.projectPermission(request) });
      }
    }
    this.permissionFingerprints = next;
  }

  private emitPlanChanges(): void {
    const pending = this.app.planHandoffStore.listPending();
    const next = fingerprints(pending, (handoff) => handoff.id);
    for (const handoff of pending) {
      if (this.planFingerprints.get(handoff.id) !== next.get(handoff.id)) {
        this.emit({ kind: 'planHandoff.changed', handoff: projectPlanHandoff(handoff) });
      }
    }
    this.planFingerprints = next;
  }

  private emitRunChange(event: TraceEvent): void {
    const record = event as Record<string, unknown>;
    const runId = stringValue(record.runId)
      ?? stringValue(record.planRunId)
      ?? stringValue(record.sourceRunId);
    if (!runId) return;
    const run = this.app.runs.get(runId);
    if (!run) return;
    const fingerprint = JSON.stringify(run);
    if (this.runFingerprints.get(runId) === fingerprint) return;
    this.runFingerprints.set(runId, fingerprint);
    this.emit({ kind: 'run.changed', run: projectRun(run) });
  }

  private trackProposalLink(event: TraceEvent): void {
    const record = event as Record<string, unknown>;
    const runId = stringValue(record.runId);
    const proposalId = stringValue(record.proposalId);
    if (runId && proposalId) this.proposalIdByRunId.set(runId, proposalId);
  }

  private rememberTraceId(id: string): boolean {
    if (this.seenTraceIds.has(id)) return false;
    this.seenTraceIds.set(id, true);
    return true;
  }
}

interface TraceIndexCursorRow {
  rowId: number;
  eventId: string;
  timestamp: number;
  segmentPath: string;
}

/**
 * Reads every indexed trace append after a fixed startup boundary. The row-id and
 * timestamp overlap cover normal appends, clock changes, and top-row deletion/reuse
 * without imposing the public trace query limit on Runtime event delivery.
 */
class IndexedTraceCursor {
  private lastRowId = 0;
  private lastTimestamp = 0;
  private eventIdsAtLastTimestamp = new Set<string>();

  private constructor(private readonly catalog: TraceCatalog & { index: NonNullable<TraceCatalog['index']> }) {}

  static create(catalog: TraceCatalog | undefined): IndexedTraceCursor | null {
    return catalog?.index ? new IndexedTraceCursor({ ...catalog, index: catalog.index }) : null;
  }

  prime(): void {
    const boundary = this.catalog.index.db.prepare(
      'SELECT COALESCE(MAX(rowid), 0) AS row_id, COALESCE(MAX(ts), 0) AS timestamp FROM trace_index'
    ).get() as { row_id: number; timestamp: number };
    this.lastRowId = Number(boundary.row_id);
    this.lastTimestamp = Number(boundary.timestamp);
    this.eventIdsAtLastTimestamp = this.readEventIdsAtTimestamp(this.lastTimestamp);
  }

  readNewEvents(): TraceEvent[] {
    const previousRowId = this.lastRowId;
    const previousTimestamp = this.lastTimestamp;
    const previousBoundaryIds = this.eventIdsAtLastTimestamp;
    const rows = this.catalog.index.db.prepare(
      `SELECT rowid AS row_id, event_id, ts, segment_path
       FROM trace_index
       WHERE rowid > ? OR ts >= ?
       ORDER BY rowid ASC`
    ).all(previousRowId, previousTimestamp) as Array<{
      row_id: number;
      event_id: string;
      ts: number;
      segment_path: string;
    }>;
    const normalized = rows.map((row): TraceIndexCursorRow => ({
      rowId: Number(row.row_id),
      eventId: row.event_id,
      timestamp: Number(row.ts),
      segmentPath: row.segment_path
    }));
    const pending = normalized.filter((row) => (
      row.rowId > previousRowId
      || row.timestamp > previousTimestamp
      || (row.timestamp === previousTimestamp && !previousBoundaryIds.has(row.eventId))
    ));
    if (pending.length === 0) return [];

    const events = this.readEvents(pending);
    let latestRowId = previousRowId;
    let latestTimestamp = previousTimestamp;
    for (const row of normalized) {
      latestRowId = Math.max(latestRowId, row.rowId);
      latestTimestamp = Math.max(latestTimestamp, row.timestamp);
    }
    this.lastRowId = latestRowId;
    if (latestTimestamp > previousTimestamp) {
      this.lastTimestamp = latestTimestamp;
      this.eventIdsAtLastTimestamp = new Set(
        normalized.filter((row) => row.timestamp === latestTimestamp).map((row) => row.eventId)
      );
    } else {
      for (const row of normalized) {
        if (row.timestamp === previousTimestamp) this.eventIdsAtLastTimestamp.add(row.eventId);
      }
    }
    return events;
  }

  private readEventIdsAtTimestamp(timestamp: number): Set<string> {
    if (timestamp <= 0) return new Set();
    const rows = this.catalog.index.db.prepare(
      'SELECT event_id FROM trace_index WHERE ts = ?'
    ).all(timestamp) as Array<{ event_id: string }>;
    return new Set(rows.map((row) => row.event_id));
  }

  private readEvents(rows: readonly TraceIndexCursorRow[]): TraceEvent[] {
    const wantedBySegment = new Map<string, Set<string>>();
    for (const row of rows) {
      let wanted = wantedBySegment.get(row.segmentPath);
      if (!wanted) {
        wanted = new Set();
        wantedBySegment.set(row.segmentPath, wanted);
      }
      wanted.add(row.eventId);
    }
    const eventsBySegment = new Map<string, Map<string, TraceEvent>>();
    for (const [segmentPath, wanted] of wantedBySegment) {
      const eventsById = new Map<string, TraceEvent>();
      eventsBySegment.set(segmentPath, eventsById);
      let text: string;
      try {
        text = readTraceSegmentUtf8(toAbsoluteSegment(this.catalog.tracesDir, segmentPath));
      } catch {
        // Lifecycle cleanup may remove a segment between the index read and file read.
        continue;
      }
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as TraceEvent;
          const id = traceId(event);
          if (id && wanted.has(id)) {
            eventsById.set(id, redactValue(event) as TraceEvent);
          }
        } catch {
          // A partial/corrupt line is ignored consistently with the durable trace query path.
        }
      }
    }
    const events = rows.map((row) => eventsBySegment.get(row.segmentPath)?.get(row.eventId));
    const unavailable = events.filter((event) => event === undefined).length;
    if (unavailable > 0) {
      throw new Error(`indexed_trace_batch_unavailable:${unavailable}`);
    }
    return events as TraceEvent[];
  }
}

class BoundedCache<Key, Value> {
  private readonly values = new Map<Key, Value>();

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('bounded_cache_limit_invalid');
  }

  get size(): number {
    return this.values.size;
  }

  has(key: Key): boolean {
    return this.values.has(key);
  }

  get(key: Key): Value | undefined {
    return this.values.get(key);
  }

  set(key: Key, value: Value): void {
    if (!this.values.has(key) && this.values.size >= this.limit) {
      const oldest = this.values.keys().next();
      if (!oldest.done) this.values.delete(oldest.value);
    }
    this.values.set(key, value);
  }
}

function traceId(event: TraceEvent): string | undefined {
  return stringValue((event as Record<string, unknown>).eventId);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function fingerprints<T>(items: readonly T[], id: (item: T) => string): Map<string, string> {
  return new Map(items.map((item) => [id(item), JSON.stringify(item)]));
}

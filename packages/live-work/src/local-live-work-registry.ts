export type LiveWorkKind = 'process' | 'terminal' | 'subagent' | (string & {});
export type LiveWorkStatus =
  | 'running'
  | 'stopping'
  | 'completed'
  | 'killed'
  | 'failed'
  | 'interrupted';
export type LiveWorkOutputChannel = 'stdout' | 'stderr' | 'terminal' | 'system';
export type LiveWorkSignal = 'interrupt' | 'terminate' | 'kill';

export interface LiveWorkOwner {
  readonly authority: 'agent-run' | 'renderer' | (string & {});
  readonly ownerId: string;
  readonly workspaceId: string;
}

export type LiveWorkMetadata = Readonly<Record<string, string | number | boolean | null>>;

export interface LiveWorkCapabilities {
  readonly input: boolean;
  readonly resize: boolean;
  readonly signal: boolean;
}

export interface LiveWorkSnapshot {
  readonly id: string;
  readonly kind: LiveWorkKind;
  readonly label: string;
  readonly status: LiveWorkStatus;
  readonly owner: LiveWorkOwner;
  readonly capabilities: LiveWorkCapabilities;
  readonly metadata: LiveWorkMetadata;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly detail?: string;
  readonly exitCode?: number;
  readonly outputCursor: number;
  readonly retainedFromCursor: number;
  readonly reported: boolean;
}

export interface LiveWorkOutputChunk {
  readonly sequence: number;
  readonly cursor: number;
  readonly byteLength: number;
  readonly channel: LiveWorkOutputChannel;
  readonly text: string;
  readonly observedAt: string;
}

export interface LiveWorkReadResult {
  readonly snapshot: LiveWorkSnapshot;
  readonly chunks: readonly LiveWorkOutputChunk[];
  readonly nextCursor: number;
  readonly truncatedBeforeCursor: boolean;
}

export interface LiveWorkOutcome {
  readonly status: 'completed' | 'killed' | 'failed' | 'interrupted';
  readonly detail?: string;
  readonly exitCode?: number;
}

export interface LiveWorkResize {
  readonly columns: number;
  readonly rows: number;
}

export interface LiveWorkController {
  readonly done: Promise<LiveWorkOutcome>;
  cancel(reason: string): void | Promise<void>;
  write?(text: string): void | Promise<void>;
  resize?(size: LiveWorkResize): void | Promise<void>;
  signal?(signal: LiveWorkSignal): void | Promise<void>;
}

export interface LiveWorkStartContext {
  readonly id: string;
  appendOutput(channel: LiveWorkOutputChannel, text: string): void;
  patchMetadata(patch: LiveWorkMetadata): void;
}

export interface LiveWorkStart {
  readonly kind: LiveWorkKind;
  readonly label: string;
  readonly owner: LiveWorkOwner;
  readonly dedupeKey?: string;
  readonly preferredId?: string;
  readonly metadata?: LiveWorkMetadata;
  readonly maxRetainedOutputBytes?: number;
  start(context: LiveWorkStartContext): LiveWorkController;
}

export interface LiveWorkDoneEvent {
  readonly snapshot: LiveWorkSnapshot;
  readonly outcome: LiveWorkOutcome;
}

export interface LiveWorkOutputEvent {
  readonly snapshot: LiveWorkSnapshot;
  readonly chunk: LiveWorkOutputChunk;
}

export interface LiveWorkWaitResult {
  readonly completed: boolean;
  readonly snapshot: LiveWorkSnapshot;
}

export interface LiveWorkRegistryOptions {
  createId(): string;
  readonly maxConcurrentPerOwner?: number;
  readonly defaultMaxRetainedOutputBytes?: number;
  readonly now?: () => Date;
}

interface MutableOutputChunk {
  sequence: number;
  cursor: number;
  byteLength: number;
  channel: LiveWorkOutputChannel;
  text: string;
  observedAt: string;
}

interface LiveRecord {
  readonly id: string;
  readonly kind: LiveWorkKind;
  readonly label: string;
  readonly owner: LiveWorkOwner;
  readonly dedupeKey?: string;
  readonly controller: LiveWorkController;
  readonly capabilities: LiveWorkCapabilities;
  readonly startedAt: string;
  readonly maxRetainedOutputBytes: number;
  readonly settled: Promise<void>;
  resolveSettled(): void;
  metadata: Record<string, string | number | boolean | null>;
  status: LiveWorkStatus;
  finishedAt?: string;
  detail?: string;
  exitCode?: number;
  outputCursor: number;
  outputSequence: number;
  retainedBytes: number;
  output: MutableOutputChunk[];
  reported: boolean;
  cancelRequested: boolean;
  inputActive: boolean;
}

const DEFAULT_MAX_CONCURRENT_PER_OWNER = 8;
const DEFAULT_MAX_RETAINED_OUTPUT_BYTES = 512 * 1024;
const MAX_OUTPUT_CHUNK_BYTES = 16 * 1024;

/**
 * Process-local authority for every piece of live work. Producers own their OS
 * resources; this registry owns identity, exact-owner access, lifecycle,
 * bounded output, cancellation ordering, and completion publication.
 */
export class LocalLiveWorkRegistry {
  private readonly records = new Map<string, LiveRecord>();
  private readonly dedupeIndex = new Map<string, string>();
  private readonly changedListeners = new Set<(snapshot: LiveWorkSnapshot) => void>();
  private readonly outputListeners = new Set<(event: LiveWorkOutputEvent) => void>();
  private readonly doneListeners = new Set<(event: LiveWorkDoneEvent) => void>();
  private readonly maxConcurrentPerOwner: number;
  private readonly defaultMaxRetainedOutputBytes: number;
  private readonly now: () => Date;
  private closing = false;
  private closePromise?: Promise<void>;

  public constructor(private readonly options: LiveWorkRegistryOptions) {
    this.maxConcurrentPerOwner = positiveInteger(
      options.maxConcurrentPerOwner ?? DEFAULT_MAX_CONCURRENT_PER_OWNER,
      'live_work_owner_limit_invalid'
    );
    this.defaultMaxRetainedOutputBytes = positiveInteger(
      options.defaultMaxRetainedOutputBytes ?? DEFAULT_MAX_RETAINED_OUTPUT_BYTES,
      'live_work_output_limit_invalid'
    );
    this.now = options.now ?? (() => new Date());
  }

  public start(input: LiveWorkStart): LiveWorkSnapshot {
    if (this.closing) throw new Error('live_work_registry_closing');
    validateOwner(input.owner);
    const dedupeIndexKey = input.dedupeKey === undefined
      ? undefined
      : dedupeKey(input.owner, input.dedupeKey);
    if (dedupeIndexKey !== undefined) {
      const existingId = this.dedupeIndex.get(dedupeIndexKey);
      const existing = existingId === undefined ? undefined : this.records.get(existingId);
      if (existing !== undefined) return snapshot(existing);
    }
    const active = [...this.records.values()].filter(
      (record) => sameOwner(record.owner, input.owner) && !terminal(record.status)
    ).length;
    if (active >= this.maxConcurrentPerOwner) throw new Error('live_work_owner_limit_reached');

    const id = input.preferredId ?? this.options.createId();
    if (id.length === 0 || this.records.has(id)) throw new Error('live_work_id_unavailable');
    const maxRetainedOutputBytes = positiveInteger(
      input.maxRetainedOutputBytes ?? this.defaultMaxRetainedOutputBytes,
      'live_work_output_limit_invalid'
    );
    const pendingOutput: { channel: LiveWorkOutputChannel; text: string }[] = [];
    let pendingMetadata: Record<string, string | number | boolean | null> = {};
    let published = false;
    const context: LiveWorkStartContext = Object.freeze({
      id,
      appendOutput: (channel: LiveWorkOutputChannel, text: string) => {
        if (text.length === 0) return;
        if (!published) pendingOutput.push({ channel, text });
        else this.appendOutput(id, channel, text);
      },
      patchMetadata: (patch: LiveWorkMetadata) => {
        if (!published) pendingMetadata = { ...pendingMetadata, ...patch };
        else this.patchMetadata(id, patch);
      }
    });

    // Producer start is deliberately synchronous: a throwing preflight cannot
    // publish a ghost record. Once a controller is returned, it owns cleanup.
    const controller = input.start(context);
    if (!(controller.done instanceof Promise)) throw new Error('live_work_controller_invalid');
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const record: LiveRecord = {
      id,
      kind: input.kind,
      label: input.label,
      owner: Object.freeze({ ...input.owner }),
      ...(input.dedupeKey === undefined ? {} : { dedupeKey: input.dedupeKey }),
      controller,
      capabilities: Object.freeze({
        input: controller.write !== undefined,
        resize: controller.resize !== undefined,
        signal: controller.signal !== undefined
      }),
      startedAt: this.now().toISOString(),
      maxRetainedOutputBytes,
      settled,
      resolveSettled,
      metadata: { ...(input.metadata ?? {}), ...pendingMetadata },
      status: 'running',
      outputCursor: 0,
      outputSequence: 0,
      retainedBytes: 0,
      output: [],
      reported: false,
      cancelRequested: false,
      inputActive: false
    };
    this.records.set(id, record);
    if (dedupeIndexKey !== undefined) this.dedupeIndex.set(dedupeIndexKey, id);
    published = true;
    for (const output of pendingOutput) this.appendOutput(id, output.channel, output.text);
    this.emitChanged(record);
    void controller.done.then(
      (outcome) => this.settle(record, outcome),
      (error) => this.settle(record, { status: 'failed', detail: errorMessage(error) })
    );
    return snapshot(record);
  }

  public get(owner: LiveWorkOwner, id: string): LiveWorkSnapshot {
    return snapshot(this.requireOwned(owner, id));
  }

  public list(owner: LiveWorkOwner): readonly LiveWorkSnapshot[] {
    return [...this.records.values()].filter((record) => sameOwner(record.owner, owner)).map(snapshot);
  }

  public read(owner: LiveWorkOwner, id: string, cursor = 0, maxBytes = 64 * 1024): LiveWorkReadResult {
    const record = this.requireOwned(owner, id);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('live_work_cursor_invalid');
    positiveInteger(maxBytes, 'live_work_read_limit_invalid');
    const retainedFromCursor = record.output[0]?.cursor ?? record.outputCursor;
    let remaining = maxBytes;
    const chunks: LiveWorkOutputChunk[] = [];
    for (const chunk of record.output) {
      if (chunk.cursor + chunk.byteLength <= cursor || remaining <= 0) continue;
      const selected = selectUtf8(chunk.text, Math.max(0, cursor - chunk.cursor), remaining);
      if (selected.text.length === 0) continue;
      chunks.push(Object.freeze({
        sequence: chunk.sequence,
        cursor: chunk.cursor + selected.startByte,
        byteLength: selected.byteLength,
        channel: chunk.channel,
        text: selected.text,
        observedAt: chunk.observedAt
      }));
      remaining -= selected.byteLength;
    }
    const last = chunks.at(-1);
    const nextCursor = last === undefined
      ? Math.max(cursor, retainedFromCursor)
      : last.cursor + last.byteLength;
    if (terminal(record.status) && nextCursor >= record.outputCursor) record.reported = true;
    return Object.freeze({
      snapshot: snapshot(record),
      chunks: Object.freeze(chunks),
      nextCursor,
      truncatedBeforeCursor: cursor < retainedFromCursor
    });
  }

  public async write(owner: LiveWorkOwner, id: string, text: string): Promise<LiveWorkSnapshot> {
    const record = this.requireOwned(owner, id);
    if (record.status !== 'running') throw new Error('live_work_not_running');
    if (record.controller.write === undefined) throw new Error('live_work_input_unsupported');
    if (record.inputActive) throw new Error('live_work_input_active');
    record.inputActive = true;
    try {
      await record.controller.write(text);
      return snapshot(record);
    } finally {
      record.inputActive = false;
    }
  }

  public async resize(owner: LiveWorkOwner, id: string, size: LiveWorkResize): Promise<LiveWorkSnapshot> {
    const record = this.requireOwned(owner, id);
    if (record.status !== 'running') throw new Error('live_work_not_running');
    if (record.controller.resize === undefined) throw new Error('live_work_resize_unsupported');
    await record.controller.resize(size);
    return snapshot(record);
  }

  public async signal(owner: LiveWorkOwner, id: string, signal: LiveWorkSignal): Promise<LiveWorkSnapshot> {
    const record = this.requireOwned(owner, id);
    if (record.status !== 'running') throw new Error('live_work_not_running');
    if (record.controller.signal === undefined) throw new Error('live_work_signal_unsupported');
    await record.controller.signal(signal);
    return snapshot(record);
  }

  public async kill(
    owner: LiveWorkOwner,
    id: string,
    reason = 'owner_requested',
    timeoutMs = 5_000
  ): Promise<LiveWorkSnapshot> {
    return this.cancelRecord(this.requireOwned(owner, id), reason, timeoutMs, true);
  }

  public async wait(
    owner: LiveWorkOwner,
    id: string,
    timeoutMs = 30_000
  ): Promise<LiveWorkWaitResult> {
    const record = this.requireOwned(owner, id);
    const completed = terminal(record.status) || await waitFor(record.settled, timeoutMs);
    if (completed) record.reported = true;
    return Object.freeze({ completed, snapshot: snapshot(record) });
  }

  public claimUnreportedCompletions(owner: LiveWorkOwner): readonly LiveWorkSnapshot[] {
    const completed = [...this.records.values()].filter(
      (record) => sameOwner(record.owner, owner) && terminal(record.status) && !record.reported
    );
    for (const record of completed) record.reported = true;
    return Object.freeze(completed.map(snapshot));
  }

  public onChanged(listener: (snapshot: LiveWorkSnapshot) => void): () => void {
    this.changedListeners.add(listener);
    return () => this.changedListeners.delete(listener);
  }

  public onOutput(listener: (event: LiveWorkOutputEvent) => void): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  public onDone(listener: (event: LiveWorkDoneEvent) => void): () => void {
    this.doneListeners.add(listener);
    return () => this.doneListeners.delete(listener);
  }

  public async closeOwner(owner: LiveWorkOwner, timeoutMs = 5_000): Promise<void> {
    const live = [...this.records.values()].filter(
      (record) => sameOwner(record.owner, owner) && !terminal(record.status)
    );
    await Promise.all(live.map((record) => this.cancelRecord(record, 'owner_closed', timeoutMs, false)));
  }

  public async closeAuthorityOwner(
    authority: LiveWorkOwner['authority'],
    ownerId: string,
    timeoutMs = 5_000
  ): Promise<void> {
    const live = [...this.records.values()].filter(
      (record) => record.owner.authority === authority
        && record.owner.ownerId === ownerId
        && !terminal(record.status)
    );
    await Promise.all(live.map((record) => this.cancelRecord(record, 'owner_closed', timeoutMs, false)));
  }

  public close(timeoutMs = 5_000): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closing = true;
    this.closePromise = Promise.all(
      [...this.records.values()]
        .filter((record) => !terminal(record.status))
        .map((record) => this.cancelRecord(record, 'registry_closed', timeoutMs, false))
    ).then(() => undefined);
    return this.closePromise;
  }

  private appendOutput(id: string, channel: LiveWorkOutputChannel, text: string): void {
    const record = this.records.get(id);
    if (record === undefined || text.length === 0) return;
    for (const part of splitUtf8(text, MAX_OUTPUT_CHUNK_BYTES)) {
      const byteLength = utf8Encoder.encode(part).byteLength;
      const chunk: MutableOutputChunk = {
        sequence: record.outputSequence++,
        cursor: record.outputCursor,
        byteLength,
        channel,
        text: part,
        observedAt: this.now().toISOString()
      };
      record.outputCursor += byteLength;
      record.retainedBytes += byteLength;
      record.output.push(chunk);
      while (record.retainedBytes > record.maxRetainedOutputBytes && record.output.length > 1) {
        const removed = record.output.shift()!;
        record.retainedBytes -= removed.byteLength;
      }
      const event = Object.freeze({ snapshot: snapshot(record), chunk: Object.freeze({ ...chunk }) });
      for (const listener of this.outputListeners) safelyNotify(() => listener(event));
    }
    this.emitChanged(record);
  }

  private patchMetadata(id: string, patch: LiveWorkMetadata): void {
    const record = this.records.get(id);
    if (record === undefined || terminal(record.status)) return;
    record.metadata = { ...record.metadata, ...patch };
    this.emitChanged(record);
  }

  private async cancelRecord(
    record: LiveRecord,
    reason: string,
    timeoutMs: number,
    report: boolean
  ): Promise<LiveWorkSnapshot> {
    if (terminal(record.status)) {
      if (report) record.reported = true;
      return snapshot(record);
    }
    if (!record.cancelRequested) {
      record.cancelRequested = true;
      record.status = 'stopping';
      this.emitChanged(record);
      try {
        const cancellation = record.controller.cancel(reason);
        void Promise.resolve(cancellation).catch((error) => {
          this.settle(record, { status: 'failed', detail: errorMessage(error) });
        });
      } catch (error) {
        this.settle(record, { status: 'failed', detail: errorMessage(error) });
      }
    }
    await waitFor(record.settled, timeoutMs);
    if (report && terminal(record.status)) record.reported = true;
    return snapshot(record);
  }

  private settle(record: LiveRecord, outcome: LiveWorkOutcome): void {
    if (terminal(record.status)) return;
    record.status = record.cancelRequested && outcome.status === 'completed' ? 'killed' : outcome.status;
    record.finishedAt = this.now().toISOString();
    if (outcome.detail !== undefined) record.detail = outcome.detail;
    if (outcome.exitCode !== undefined) record.exitCode = outcome.exitCode;
    record.resolveSettled();
    const committedSnapshot = snapshot(record);
    this.emitChanged(record);
    const event = Object.freeze({ snapshot: committedSnapshot, outcome: Object.freeze({ ...outcome }) });
    for (const listener of this.doneListeners) safelyNotify(() => listener(event));
  }

  private requireOwned(owner: LiveWorkOwner, id: string): LiveRecord {
    const record = this.records.get(id);
    if (record === undefined || !sameOwner(record.owner, owner)) throw new Error('live_work_not_found');
    return record;
  }

  private emitChanged(record: LiveRecord): void {
    const current = snapshot(record);
    for (const listener of this.changedListeners) safelyNotify(() => listener(current));
  }
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

function splitUtf8(text: string, maxBytes: number): readonly string[] {
  const bytes = utf8Encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return [text];
  const parts: string[] = [];
  let start = 0;
  while (start < bytes.byteLength) {
    let end = Math.min(bytes.byteLength, start + maxBytes);
    while (end < bytes.byteLength && isContinuationByte(bytes[end]!)) end -= 1;
    if (end === start) end = Math.min(bytes.byteLength, start + 4);
    parts.push(utf8Decoder.decode(bytes.subarray(start, end)));
    start = end;
  }
  return parts;
}

function selectUtf8(
  text: string,
  requestedStart: number,
  maxBytes: number
): { startByte: number; byteLength: number; text: string } {
  const bytes = utf8Encoder.encode(text);
  let start = Math.min(requestedStart, bytes.byteLength);
  while (start < bytes.byteLength && isContinuationByte(bytes[start]!)) start += 1;
  if (start >= bytes.byteLength) return { startByte: start, byteLength: 0, text: '' };
  let end = Math.min(bytes.byteLength, start + maxBytes);
  while (end < bytes.byteLength && end > start && isContinuationByte(bytes[end]!)) end -= 1;
  if (end === start) {
    end += 1;
    while (end < bytes.byteLength && isContinuationByte(bytes[end]!)) end += 1;
  }
  return {
    startByte: start,
    byteLength: end - start,
    text: utf8Decoder.decode(bytes.subarray(start, end))
  };
}

function isContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function snapshot(record: LiveRecord): LiveWorkSnapshot {
  const retainedFromCursor = record.output[0]?.cursor ?? record.outputCursor;
  return Object.freeze({
    id: record.id,
    kind: record.kind,
    label: record.label,
    status: record.status,
    owner: record.owner,
    capabilities: record.capabilities,
    metadata: Object.freeze({ ...record.metadata }),
    startedAt: record.startedAt,
    ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
    ...(record.detail === undefined ? {} : { detail: record.detail }),
    ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
    outputCursor: record.outputCursor,
    retainedFromCursor,
    reported: record.reported
  });
}

function terminal(status: LiveWorkStatus): boolean {
  return status === 'completed' || status === 'killed' || status === 'failed' || status === 'interrupted';
}

function validateOwner(owner: LiveWorkOwner): void {
  if (owner.authority.length === 0 || owner.ownerId.length === 0 || owner.workspaceId.length === 0) {
    throw new Error('live_work_owner_invalid');
  }
}

function sameOwner(left: LiveWorkOwner, right: LiveWorkOwner): boolean {
  return left.authority === right.authority
    && left.ownerId === right.ownerId
    && left.workspaceId === right.workspaceId;
}

function dedupeKey(owner: LiveWorkOwner, key: string): string {
  return `${owner.authority}\0${owner.ownerId}\0${owner.workspaceId}\0${key}`;
}

function positiveInteger(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(code);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 4_096) : String(error).slice(0, 4_096);
}

function safelyNotify(notify: () => void): void {
  try {
    notify();
  } catch {
    // A diagnostics/UI listener cannot corrupt registry state or producer cleanup.
  }
}

async function waitFor(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new Error('live_work_wait_timeout_invalid');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

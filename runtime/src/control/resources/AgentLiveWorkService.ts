import {
  LocalLiveWorkRegistry,
  type LiveWorkDoneEvent,
  type LiveWorkOwner,
  type LiveWorkReadResult,
  type LiveWorkResize,
  type LiveWorkSignal,
  type LiveWorkSnapshot,
  type LiveWorkStart,
  type LiveWorkWaitResult
} from '@ariadne/live-work';
import type {
  AgentControlLiveWorkService,
  AgentLiveWorkCompletionBinding,
  AgentLiveWorkCompletionNotification
} from '../ports/AgentLiveWork.js';

const MAX_OWNER_LIVE_WORK = 8;
const MAX_RETAINED_OUTPUT_BYTES = 512 * 1024;

export interface AgentLiveWorkOwner {
  readonly runId: string;
  readonly workspaceId: string;
}

/**
 * Runtime control authority for all Agent-owned live work. Producers register
 * controllers here; Tool families consume this service without owning another
 * identity map, output buffer, or lifecycle state machine.
 */
export class AgentLiveWorkService implements AgentControlLiveWorkService {
  private readonly registry: LocalLiveWorkRegistry;
  private completionSink?: (notification: AgentLiveWorkCompletionNotification) => Promise<void>;
  private readonly pendingNotifications = new Set<Promise<void>>();
  private readonly bufferedNotifications: AgentLiveWorkCompletionNotification[] = [];
  private notificationFailure: unknown;

  public constructor() {
    this.registry = new LocalLiveWorkRegistry({
      createId: () => { throw new Error('agent_live_work_preferred_id_required'); },
      maxConcurrentPerOwner: MAX_OWNER_LIVE_WORK,
      defaultMaxRetainedOutputBytes: MAX_RETAINED_OUTPUT_BYTES
    });
    this.registry.onDone((event) => this.dispatchCompletion(event));
  }

  public start(
    owner: AgentLiveWorkOwner,
    input: Omit<LiveWorkStart, 'owner'>
  ): LiveWorkSnapshot {
    return this.registry.start({ ...input, owner: liveOwner(owner) });
  }

  public get(owner: AgentLiveWorkOwner, jobId: string): LiveWorkSnapshot {
    return this.registry.get(liveOwner(owner), jobId);
  }

  public list(owner: AgentLiveWorkOwner): readonly LiveWorkSnapshot[] {
    return this.registry.list(liveOwner(owner));
  }

  public read(
    owner: AgentLiveWorkOwner,
    jobId: string,
    cursor = 0,
    maxBytes = 64 * 1024
  ): LiveWorkReadResult {
    return this.registry.read(liveOwner(owner), jobId, cursor, maxBytes);
  }

  public write(owner: AgentLiveWorkOwner, jobId: string, text: string): Promise<LiveWorkSnapshot> {
    return this.registry.write(liveOwner(owner), jobId, text);
  }

  public resize(
    owner: AgentLiveWorkOwner,
    jobId: string,
    size: LiveWorkResize
  ): Promise<LiveWorkSnapshot> {
    return this.registry.resize(liveOwner(owner), jobId, size);
  }

  public signal(
    owner: AgentLiveWorkOwner,
    jobId: string,
    signal: LiveWorkSignal
  ): Promise<LiveWorkSnapshot> {
    return this.registry.signal(liveOwner(owner), jobId, signal);
  }

  public kill(owner: AgentLiveWorkOwner, jobId: string): Promise<LiveWorkSnapshot> {
    return this.registry.kill(liveOwner(owner), jobId, 'agent_requested');
  }

  public wait(
    owner: AgentLiveWorkOwner,
    jobId: string,
    timeoutMs: number
  ): Promise<LiveWorkWaitResult> {
    return this.registry.wait(liveOwner(owner), jobId, timeoutMs);
  }

  public claimUnreportedCompletions(owner: AgentLiveWorkOwner): readonly LiveWorkSnapshot[] {
    return this.registry.claimUnreportedCompletions(liveOwner(owner));
  }

  public onDone(listener: (event: LiveWorkDoneEvent) => void): () => void {
    return this.registry.onDone(listener);
  }

  public bindCompletionSink(
    sink: (notification: AgentLiveWorkCompletionNotification) => Promise<void>
  ): AgentLiveWorkCompletionBinding {
    if (this.completionSink !== undefined) {
      throw new Error('agent_live_work_completion_sink_already_bound');
    }
    this.completionSink = sink;
    for (const notification of this.bufferedNotifications.splice(0)) {
      this.publishCompletion(sink, notification);
    }
    let bound = true;
    return Object.freeze({
      assertHealthy: () => this.assertNotificationHealthy(),
      drain: (timeoutMs: number) => this.drainNotifications(timeoutMs),
      unbind: () => {
        if (!bound) return;
        bound = false;
        if (this.completionSink === sink) this.completionSink = undefined;
      }
    });
  }

  public closeOwner(runId: string, timeoutMs = 5_000): Promise<void> {
    return this.registry.closeAuthorityOwner('agent-run', runId, timeoutMs);
  }

  public close(timeoutMs = 5_000): Promise<void> {
    return this.closeAndDrain(timeoutMs);
  }

  private async closeAndDrain(timeoutMs: number): Promise<void> {
    await this.registry.close(timeoutMs);
    await this.drainNotifications(timeoutMs);
  }

  private dispatchCompletion(event: LiveWorkDoneEvent): void {
    try {
      const notification = completionNotification(event);
      const sink = this.completionSink;
      if (sink === undefined) {
        if (this.bufferedNotifications.length >= 1_000) {
          throw new Error('agent_live_work_completion_buffer_exhausted');
        }
        this.bufferedNotifications.push(notification);
        return;
      }
      this.publishCompletion(sink, notification);
    } catch (error) {
      this.notificationFailure ??= error;
    }
  }

  private publishCompletion(
    sink: (notification: AgentLiveWorkCompletionNotification) => Promise<void>,
    notification: AgentLiveWorkCompletionNotification
  ): void {
    const operation = Promise.resolve()
      .then(async () => {
        await sink(notification);
        await this.registry.wait(liveOwner({
          runId: notification.runId,
          workspaceId: notification.workspaceId
        }), notification.jobId, 0);
      })
      .catch((error) => { this.notificationFailure ??= error; })
      .finally(() => this.pendingNotifications.delete(operation));
    this.pendingNotifications.add(operation);
  }

  private async drainNotifications(timeoutMs: number): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
      throw new Error('agent_live_work_notification_timeout_invalid');
    }
    const pending = Promise.all([...this.pendingNotifications]);
    await withTimeout(pending, timeoutMs);
    this.assertNotificationHealthy();
  }

  private assertNotificationHealthy(): void {
    if (this.notificationFailure !== undefined) {
      throw new Error('agent_live_work_completion_sink_failed', {
        cause: this.notificationFailure
      });
    }
  }
}

function liveOwner(owner: AgentLiveWorkOwner): LiveWorkOwner {
  return { authority: 'agent-run', ownerId: owner.runId, workspaceId: owner.workspaceId };
}

function completionNotification(event: LiveWorkDoneEvent): AgentLiveWorkCompletionNotification {
  const snapshot = event.snapshot;
  if (
    snapshot.owner.authority !== 'agent-run'
    || snapshot.finishedAt === undefined
    || !['completed', 'killed', 'failed', 'interrupted'].includes(snapshot.status)
  ) throw new Error('agent_live_work_completion_invalid');
  return Object.freeze({
    runId: snapshot.owner.ownerId,
    workspaceId: snapshot.owner.workspaceId,
    jobId: snapshot.id,
    workKind: snapshot.kind,
    status: snapshot.status as AgentLiveWorkCompletionNotification['status'],
    finishedAt: snapshot.finishedAt,
    outputCursor: snapshot.outputCursor,
    ...(snapshot.exitCode === undefined ? {} : { exitCode: snapshot.exitCode }),
    ...(snapshot.detail === undefined ? {} : { detail: snapshot.detail })
  });
}

async function withTimeout(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('agent_live_work_completion_drain_timeout')),
          timeoutMs
        );
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

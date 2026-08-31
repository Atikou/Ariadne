import { PUBLIC_PROJECTION_CONTRACT_VERSION } from '@ariadne/protocol/public';
import type { SqliteConversationRunHandoffUnitOfWork } from '../adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import type { DueScheduleOccurrence, SqliteProductivityStore } from '../adapters/persistence/SqliteProductivityStore.js';
import type { RuntimeApplicationCommandResult } from '../ingress/RuntimeApplication.js';
import type { RuntimeCommandEnvelope } from '../ingress/RuntimeIngress.js';

/** Recovery-safe Schedule consumer that submits ordinary v3 Conversation messages. */
export class V3ScheduleWorker {
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<void> | null = null;
  private stopped = true;

  public constructor(
    private readonly store: SqliteProductivityStore,
    private readonly conversation: SqliteConversationRunHandoffUnitOfWork,
    private readonly dispatch: (envelope: RuntimeCommandEnvelope) => Promise<RuntimeApplicationCommandResult | null>,
    private readonly intervalMs = 1_000
  ) {}

  public async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.runOnce();
    this.timer = setInterval(() => { void this.wake(); }, this.intervalMs);
    this.timer.unref?.();
  }

  public wake(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.active ??= this.runOnce().finally(() => { this.active = null; });
    return this.active;
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }

  private async runOnce(): Promise<void> {
    await this.store.materializeDue();
    for (const occurrence of await this.store.pendingOccurrences()) {
      if (this.stopped) return;
      await this.dispatchOccurrence(occurrence);
    }
  }

  private async dispatchOccurrence(occurrence: DueScheduleOccurrence): Promise<void> {
    const session = await this.conversation.readSession(occurrence.sessionId);
    if (session === null || session.workspaceId !== occurrence.workspaceId || session.status !== 'active') {
      await this.store.settleOccurrence(occurrence.occurrenceId, false, 'schedule_session_unavailable');
      return;
    }
    const controller = new AbortController();
    const envelope: RuntimeCommandEnvelope = {
      commandId: occurrence.commandId,
      correlationId: occurrence.occurrenceId,
      deadlineAt: new Date(Date.now() + 120_000).toISOString(),
      signal: controller.signal,
      command: {
        kind: 'conversation.message.accept.v3',
        contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
        sessionId: occurrence.sessionId,
        workspaceId: occurrence.workspaceId,
        expectedSessionVersion: session.version,
        messageId: occurrence.messageId,
        content: occurrence.prompt,
        execution: { mode: 'agent' }
      }
    };
    try {
      const result = await this.dispatch(envelope);
      const success = result?.settlement === 'completed' && result.outcome.ok;
      await this.store.settleOccurrence(
        occurrence.occurrenceId,
        success,
        success ? undefined : 'schedule_v3_submission_rejected'
      );
    } catch {
      await this.store.settleOccurrence(occurrence.occurrenceId, false, 'schedule_v3_submission_failed');
    }
  }
}

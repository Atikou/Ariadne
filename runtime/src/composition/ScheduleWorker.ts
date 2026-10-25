import { PUBLIC_PROJECTION_CONTRACT_VERSION } from '@ariadne/protocol/public';
import type { SqliteConversationRunHandoffUnitOfWork } from '../adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import { type DueScheduleOccurrence, type SqliteProductivityStore } from '../adapters/persistence/SqliteProductivityStore.js';
import type { RuntimeApplicationCommandResult } from '../ingress/RuntimeApplication.js';
import type { RuntimeCommandEnvelope } from '../ingress/RuntimeIngress.js';
import { digestConversationMessagePayload } from '../conversation/ConversationAuthority.js';
import { ProductivityTaskInvariantError } from '../control/ports/ProductivityTaskIsolationV1.js';

/** Durable Schedule consumer; the claim precedes submission through ordinary Conversation authority. */
export class ScheduleWorker {
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private failure: unknown;
  private stopped = true;
  private quarantinedTasks = 0;
  public hasQuarantinedTasks(): boolean { return this.quarantinedTasks > 0; }

  public constructor(
    private readonly store: SqliteProductivityStore,
    private readonly conversation: SqliteConversationRunHandoffUnitOfWork,
    private readonly dispatch: (envelope: RuntimeCommandEnvelope) => Promise<RuntimeApplicationCommandResult | null>,
    private readonly intervalMs = 1_000,
    private readonly submissionTimeoutMs = 120_000
  ) {}

  public async start(): Promise<void> {
    if (!this.stopped) return;
    this.assertHealthy();
    this.stopped = false;
    try {
      await this.wake();
      if (this.stopped) return;
      this.timer = setInterval(() => {
        void this.wake().catch((error: unknown) => this.fail(error));
      }, this.intervalMs);
      this.timer.unref?.();
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  public assertHealthy(): void {
    if (this.failure !== undefined) throw this.failure;
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
    this.controller?.abort(new Error('schedule_worker_stopped'));
    await this.active;
  }

  private fail(error: unknown): void {
    this.failure = error;
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async runOnce(): Promise<void> {
    this.quarantinedTasks = await this.store.countQuarantinedTasks('schedule');
    for (const occurrence of await this.store.claimedOccurrences()) {
      if (this.stopped) return;
      await this.isolateTask(occurrence, async () => {
        if (await this.readAccepted(occurrence) !== null) await this.store.settleOccurrence(occurrence.occurrenceId, true);
      });
    }
    await this.store.materializeDue(new Date(Date.now()));
    for (const occurrence of await this.store.pendingOccurrences()) {
      if (this.stopped) return;
      await this.isolateTask(occurrence, () => this.dispatchOccurrence(occurrence));
    }
  }

  private async isolateTask(occurrence: DueScheduleOccurrence, run: () => Promise<void>): Promise<void> {
    try { await run(); }
    catch (error) {
      if (!(error instanceof ProductivityTaskInvariantError)) throw error;
      await this.store.quarantineTask('schedule', occurrence.scheduleId, occurrence.occurrenceId, error.code);
      this.quarantinedTasks = await this.store.countQuarantinedTasks('schedule');
    }
  }

  private async dispatchOccurrence(occurrence: DueScheduleOccurrence): Promise<void> {
    // Restore the original CAS input after a crash between acceptance and settlement.
    const committed = await this.readAccepted(occurrence);
    const session = committed === null ? await this.conversation.readSession(occurrence.sessionId) : null;
    if (this.stopped || !await this.store.claimOccurrence(occurrence.occurrenceId, new Date(Date.now()), this.submissionTimeoutMs)) return;
    if (committed === null && (session === null || session.workspaceId !== occurrence.workspaceId || session.status !== 'active')) {
      await this.store.settleOccurrence(occurrence.occurrenceId, false, 'schedule_session_unavailable', false);
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    if (this.stopped) controller.abort(new Error('schedule_worker_stopped'));
    const deadlineAt = new Date(Date.now() + this.submissionTimeoutMs).toISOString();
    const timer = setTimeout(() => controller.abort(new Error('schedule_submission_deadline_exceeded')), this.submissionTimeoutMs);
    timer.unref?.();
    let success = false;
    let retryable = true;
    let errorCode = 'schedule_submission_failed';
    try {
      const result = await this.dispatch({
        commandId: occurrence.commandId, correlationId: occurrence.occurrenceId, deadlineAt,
        signal: controller.signal,
        command: {
          kind: 'conversation.message.accept', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
          sessionId: occurrence.sessionId, workspaceId: occurrence.workspaceId,
          expectedSessionVersion: committed !== null ? committed.resultingSessionVersion - 1 : session!.version,
          messageId: occurrence.messageId, content: occurrence.prompt, execution: { mode: 'agent' }
        }
      });
      success = result?.settlement === 'completed' && result.outcome.ok;
      if (result?.settlement === 'completed' && !result.outcome.ok) {
        errorCode = result.outcome.error.code === 'conversation_version_conflict'
          ? 'conversation_version_conflict' : 'schedule_submission_rejected';
        // The scheduled submitter owns refreshing the CAS input; a user-facing caller must refresh manually.
        retryable = result.outcome.error.retryable || errorCode === 'conversation_version_conflict';
      } else if (!success) errorCode = 'schedule_submission_uncertain';
    } catch {
      errorCode = controller.signal.aborted
        ? this.stopped ? 'schedule_worker_stopped' : 'schedule_submission_deadline_exceeded'
        : 'schedule_submission_failed';
    } finally {
      clearTimeout(timer);
      this.controller = null;
    }
    // Persistence failures belong to worker health, not dispatch rejection handling.
    await this.store.settleOccurrence(occurrence.occurrenceId, success, success ? undefined : errorCode, retryable);
  }

  private async readAccepted(occurrence: DueScheduleOccurrence) {
    const committed = await this.conversation.readCommittedAuthorityCommand(occurrence.commandId);
    if (committed === null) return null;
    const receipt = committed.receipt;
    if (receipt.kind !== 'conversation.accept_user_message' || receipt.messageId !== occurrence.messageId || receipt.messageVersion !== 1
      || receipt.workspaceId !== occurrence.workspaceId || receipt.sessionId !== occurrence.sessionId) throw new ProductivityTaskInvariantError('submission_identity_conflict');
    const message = await this.conversation.readMessageVersion(occurrence.messageId, receipt.messageVersion);
    const expected = await digestConversationMessagePayload({ content: occurrence.prompt, execution: { mode: 'agent' } });
    if (message === null || message.role !== 'user' || message.sessionId !== occurrence.sessionId || message.workspaceId !== occurrence.workspaceId
      || message.contentDigest !== expected) throw new ProductivityTaskInvariantError('submission_identity_conflict');
    return receipt;
  }
}

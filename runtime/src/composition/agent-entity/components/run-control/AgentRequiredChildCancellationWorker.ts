import { AgentRunTransitionError, AgentRunVersionConflictError, deriveStableAgentId,
  type AgentRunRecoveryCursor, type AgentRun } from '@ariadne/agent-core';
import { PUBLIC_PROJECTION_CONTRACT_VERSION } from '@ariadne/protocol/public';
import { AgentInferenceCancellationConflictError } from '../../../../control/ports/AgentInferenceCancellationConflict.js';
import type { SqliteAgentRunUnitOfWork } from '../../../../adapters/persistence/SqliteAgentRunUnitOfWork.js';
import type { RuntimeCommandEnvelope } from '../../../../ingress/RuntimeIngress.js';
import type { ShutdownContext } from '../../../../ingress/ShutdownContext.js';
import type { AgentRunCancellationReceipt } from './AgentRunCancellationContracts.js';

type CancelCommand = Extract<RuntimeCommandEnvelope['command'], { readonly kind: 'agent.run.cancel' }>;

/** Parent cancelling state and leaf stop intents form the durable cancellation queue. */
export class AgentRequiredChildCancellationWorker {
  private lifecycle: 'new' | 'starting' | 'running' | 'stopping' | 'stopped' = 'new';
  private startOperation: Promise<void> | null = null;
  private stopOperation: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private operation: Promise<void> | null = null;
  private fault: unknown = null;
  private wakeProjection: () => void = () => undefined;
  public constructor(private readonly unit: SqliteAgentRunUnitOfWork,
    private readonly cancel: (commandId: string, command: CancelCommand) => Promise<AgentRunCancellationReceipt>,
    private readonly continueEffectCancellation?: (run: AgentRun) => Promise<void>) {}
  public start(wakeProjection: () => void): Promise<void> {
    if (this.lifecycle === 'starting' || this.lifecycle === 'running') return this.startOperation!;
    if (this.lifecycle !== 'new') return Promise.reject(new Error('required_child_cancellation_worker_cannot_restart'));
    this.wakeProjection = wakeProjection;
    this.lifecycle = 'starting';
    this.startOperation = this.finishStart();
    return this.startOperation;
  }
  private async finishStart(): Promise<void> {
    await this.drainOnce();
    if (this.lifecycle !== 'starting') return;
    this.lifecycle = 'running';
    this.timer = setInterval(() => this.wake(), 250);
    this.timer.unref?.();
  }
  public wake(): void {
    if (this.lifecycle !== 'running' || this.fault !== null || this.operation !== null) return;
    void this.drainOnce().catch(() => undefined);
  }
  public assertHealthy(): void {
    if (this.fault !== null) throw this.fault;
    if (this.lifecycle !== 'running') throw new Error('required_child_cancellation_worker_not_running');
  }
  public drainOnce(): Promise<void> {
    if (this.fault !== null) return Promise.reject(this.fault);
    if (!this.active) return Promise.reject(new Error('required_child_cancellation_worker_not_running'));
    if (this.operation !== null) return this.operation;
    const operation = this.drain().catch(error => { this.fault ??= error; throw error; }).finally(() => {
      if (this.operation === operation) this.operation = null;
    });
    this.operation = operation;
    return operation;
  }
  public stop(context: ShutdownContext): Promise<void> {
    this.stopOperation ??= this.finishStop(context);
    return this.stopOperation;
  }
  private async finishStop(context: ShutdownContext): Promise<void> {
    this.lifecycle = 'stopping';
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    const active = this.operation;
    if (active === null) { this.lifecycle = 'stopped'; return; }
    context.throwIfExpired('required_child_cancellation_shutdown_deadline');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([active, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('required_child_cancellation_shutdown_deadline')), context.remainingMs());
      })]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.lifecycle = 'stopped';
    }
  }
  private get active(): boolean { return this.lifecycle === 'starting' || this.lifecycle === 'running'; }
  private async drain(): Promise<void> {
    let cursor: AgentRunRecoveryCursor | undefined;
    const seen = new Set<string>();
    const runIds = new Set<string>();
    do {
      const page = await this.unit.listActiveRuns({ limit: 100, ...(cursor === undefined ? {} : { after: cursor }) });
      if (page.items.length > 100) throw new Error('required_child_cancellation_page_exceeds_bound');
      for (const item of page.items) {
        if (!this.active) return;
        const parent = item.run;
        if (runIds.has(parent.runId)) throw new Error('required_child_cancellation_run_repeated');
        runIds.add(parent.runId);
        if (parent.cancellationRequest !== undefined && this.continueEffectCancellation !== undefined) {
          await this.continueEffectCancellation(parent);
          this.wakeProjection();
        }
        if (parent.state.status !== 'cancelling') continue;
        for (const childId of parent.state.requiredChildRunIds) {
          if (!this.active) return;
          if (parent.state.terminalChildRunIds.includes(childId)) continue;
          const child = await this.unit.transaction(transaction => transaction.loadRun(childId));
          if (child === null) throw new Error('required_child_cancellation_child_missing');
          if (['completed', 'failed', 'cancelled'].includes(child.state.status)) { this.wakeProjection(); continue; }
          if (child.state.status === 'cancelling') continue;
          // An unknown tool outcome still requires its recovery decision; cancellation cannot manufacture its result.
          if (child.effects.some(effect => effect.state.status === 'uncertain')) continue;
          const commandId = await deriveStableAgentId('required-child-cancellation', parent.runId,
            parent.state.requestedAt, childId, String(child.version));
          try {
            await this.cancel(commandId, { kind: 'agent.run.cancel', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
              runId: childId, expectedVersion: child.version, reason: 'user_requested',
              occurredAt: new Date(Math.max(Date.now(), Date.parse(child.updatedAt))).toISOString() });
            this.wakeProjection();
          } catch (error) {
            // An in-flight Effect is joined through its own result owner. Ancestor gates prevent its next external start.
            if (error instanceof AgentRunVersionConflictError || error instanceof AgentInferenceCancellationConflictError
              || (error instanceof AgentRunTransitionError
              && (child.effects.some(effect => effect.state.status === 'started')
                || child.turns.some(turn => turn.attempts.some(attempt => attempt.state.status === 'started'))))) continue;
            throw error;
          }
        }
      }
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        const key = `${cursor.createdAt}\0${cursor.runId}`;
        if (seen.has(key)) throw new Error('required_child_cancellation_cursor_repeated');
        seen.add(key);
      }
    } while (cursor !== undefined && this.active);
  }
}

import { createShutdownContext, type ShutdownContext } from "../ingress/ShutdownContext.js";

interface AppShutdownDependencies {
  runtime: { stop(context?: ShutdownContext): Promise<void> };
  orchestrator: {
    listRunningAgentRuns(): Array<{ runId: string }>;
    cancelRun(runId: string): unknown;
    waitUntilAgentRunIdle(runId: string): Promise<void>;
  };
  trace: {
    close(context?: ShutdownContext): Promise<void>;
    getIndexStore(): { close(): void } | undefined;
  };
  registry: { close(): void };
  companionService: { close(): void };
  mcp: { stop(context?: ShutdownContext): Promise<void> };
  projectIndex: { dispose(context?: ShutdownContext): Promise<void> };
  contextDb: { close(): void };
  telemetry: { shutdown(context?: ShutdownContext): Promise<void> };
  hooks: {
    dispatch(input: {
      event: "stop";
      eventId: string;
      payload: Record<string, unknown>;
      authority: { permissions: []; timeoutMs: number };
    }): Promise<unknown>;
  };
}

/** Owns the idempotent producer-stop and store-finalization phases. */
export class AppShutdownCoordinator {
  private preparation?: Promise<void>;
  private completion?: Promise<void>;
  private context?: ShutdownContext;

  constructor(private readonly dependencies: AppShutdownDependencies) {}

  prepare(context?: ShutdownContext): Promise<void> {
    const shutdownContext = this.resolveContext(context);
    this.preparation ??= this.performPreparation(shutdownContext);
    return this.preparation;
  }

  shutdown(context?: ShutdownContext): Promise<void> {
    const shutdownContext = this.resolveContext(context);
    this.completion ??= this.performShutdown(shutdownContext);
    return this.completion;
  }

  private resolveContext(context?: ShutdownContext): ShutdownContext {
    this.context ??= context ?? createShutdownContext(Date.now() + 10_000);
    return this.context;
  }

  private async performPreparation(context: ShutdownContext): Promise<void> {
    context.throwIfExpired();
    try {
      await this.dependencies.hooks.dispatch({
        event: "stop",
        eventId: "runtime-stop",
        payload: {},
        authority: { permissions: [], timeoutMs: Math.max(1, Math.min(5_000, context.remainingMs(2_000))) },
      });
    } catch {
      // Stop delivery is durable, but a broken notification cannot prevent safe shutdown.
    }
    context.throwIfExpired();
    await this.dependencies.runtime.stop(context);
    try {
      for (const run of this.dependencies.orchestrator.listRunningAgentRuns()) {
        this.dependencies.orchestrator.cancelRun(run.runId);
      }
    } catch {
      // Cancellation is best-effort; resource finalization must still proceed.
    }
  }

  private async performShutdown(context: ShutdownContext): Promise<void> {
    try {
      await this.prepare(context);
      await this.waitForActiveRuns(context, 2_000);
    } catch (error) {
      // An unjoined run may still own database handles or external effects.
      // Retain every store and let Main terminate the fenced Runtime process.
      throw new AggregateError([error], 'app_shutdown_barrier_failed');
    }
    const failures: unknown[] = [];
    await this.runOptional(context, failures, () => this.dependencies.trace.close(context));
    this.runRequiredClose(failures, () => this.dependencies.trace.getIndexStore()?.close());
    await this.runOptional(context, failures, () => this.dependencies.mcp.stop(context));
    this.runRequiredClose(failures, () => this.dependencies.registry.close());
    this.runRequiredClose(failures, () => this.dependencies.companionService.close());
    await this.runOptional(context, failures, () => this.dependencies.projectIndex.dispose(context));
    await this.runOptional(context, failures, () => this.dependencies.telemetry.shutdown(context));
    // The primary database is the final ownership boundary and is always closed,
    // even when optional service cleanup consumed its budget or failed.
    this.runRequiredClose(failures, () => this.dependencies.contextDb.close());
    if (failures.length > 0) throw new AggregateError(failures, "app_shutdown_failed");
    context.throwIfExpired();
  }

  private async waitForActiveRuns(context: ShutdownContext, maxWaitMs: number): Promise<void> {
    context.throwIfExpired('app_shutdown_active_run_deadline_exceeded');
    const running = this.dependencies.orchestrator.listRunningAgentRuns();
    if (running.length === 0) return;
    const waitMs = Math.min(maxWaitMs, context.remainingMs(1_500));
    if (waitMs <= 0) {
      throw new Error('app_shutdown_active_run_deadline_exceeded');
    }
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      const fail = (): void => reject(
        new Error('app_shutdown_active_runs_not_drained')
      );
      timer = setTimeout(fail, waitMs);
      timer.unref?.();
      onAbort = fail;
      context.signal.addEventListener('abort', fail, { once: true });
    });
    try {
      await Promise.race([
        Promise.all(running.map((run) => (
          this.dependencies.orchestrator.waitUntilAgentRunIdle(run.runId)
        ))),
        deadline
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) context.signal.removeEventListener('abort', onAbort);
    }
    if (this.dependencies.orchestrator.listRunningAgentRuns().length !== 0) {
      throw new Error('app_shutdown_active_runs_not_drained');
    }
  }

  private async runOptional(
    context: ShutdownContext,
    failures: unknown[],
    operation: () => Promise<void>,
  ): Promise<void> {
    if (context.remainingMs(500) === 0) return;
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  }

  private runRequiredClose(failures: unknown[], operation: () => void): void {
    try {
      operation();
    } catch (error) {
      failures.push(error);
    }
  }
}

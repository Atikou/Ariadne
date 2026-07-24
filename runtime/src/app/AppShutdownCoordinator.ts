interface AppShutdownDependencies {
  runtime: { stop(): Promise<void> };
  orchestrator: {
    listRunningAgentRuns(): Array<{ runId: string }>;
    cancelRun(runId: string): unknown;
  };
  backgroundTasks: { shutdown(): Promise<void> };
  trace: {
    close(): Promise<void>;
    getIndexStore(): { close(): void } | undefined;
  };
  registry: { close(): void };
  companionService: { close(): void };
  mcp: { stop(): Promise<void> };
  projectIndex: { dispose(): Promise<void> };
  contextDb: { close(): void };
  telemetry: { shutdown(): Promise<void> };
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

  constructor(private readonly dependencies: AppShutdownDependencies) {}

  prepare(): Promise<void> {
    this.preparation ??= this.performPreparation();
    return this.preparation;
  }

  shutdown(): Promise<void> {
    this.completion ??= this.performShutdown();
    return this.completion;
  }

  private async performPreparation(): Promise<void> {
    try {
      await this.dependencies.hooks.dispatch({
        event: "stop",
        eventId: "runtime-stop",
        payload: {},
        authority: { permissions: [], timeoutMs: 5_000 },
      });
    } catch {
      // Stop delivery is durable, but a broken notification cannot prevent safe shutdown.
    }
    await this.dependencies.runtime.stop();
    try {
      for (const run of this.dependencies.orchestrator.listRunningAgentRuns()) {
        this.dependencies.orchestrator.cancelRun(run.runId);
      }
    } catch {
      // Cancellation is best-effort; resource finalization must still proceed.
    }
    await this.dependencies.backgroundTasks.shutdown();
  }

  private async performShutdown(): Promise<void> {
    await this.prepare();
    await this.waitForActiveRuns(5_000);
    await this.dependencies.trace.close();
    this.dependencies.trace.getIndexStore()?.close();
    await this.dependencies.mcp.stop();
    this.dependencies.registry.close();
    this.dependencies.companionService.close();
    await this.dependencies.projectIndex.dispose();
    await this.dependencies.telemetry.shutdown();
    this.dependencies.contextDb.close();
  }

  private async waitForActiveRuns(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      let running = 0;
      try {
        running = this.dependencies.orchestrator.listRunningAgentRuns().length;
      } catch {
        return;
      }
      if (running === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

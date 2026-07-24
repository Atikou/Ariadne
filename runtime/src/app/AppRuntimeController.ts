export interface RuntimeScheduler {
  start(): void;
  stop(): void;
}

export interface AutoCleanupRunner {
  runAutoSafeCleanup():
    | { autoSkipped: true; reason: string }
    | { cleanupRunId: string; bytesFreed: number; applied: number };
}

export interface AppRuntimeControllerOptions {
  scheduler: RuntimeScheduler;
  dataLifecycle: AutoCleanupRunner;
  autoCleanupEnabled: boolean;
  autoCleanupIntervalMs: number;
  autoCleanupInitialDelayMs?: number;
  log?: Pick<Console, "log" | "warn">;
  managedRuntime?: {
    start(): void;
    stop(): void | Promise<void>;
  };
}

/** Owns process-level timers. Dependency construction remains side-effect free. */
export class AppRuntimeController {
  private started = false;
  private initialCleanupTimer?: NodeJS.Timeout;
  private cleanupInterval?: NodeJS.Timeout;
  private readonly log: Pick<Console, "log" | "warn">;

  constructor(private readonly options: AppRuntimeControllerOptions) {
    this.log = options.log ?? console;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.options.managedRuntime?.start();
    this.options.scheduler.start();
    if (!this.options.autoCleanupEnabled) return;

    const run = (): void => {
      try {
        const result = this.options.dataLifecycle.runAutoSafeCleanup();
        if ("autoSkipped" in result) return;
        this.log.log(
          `[lifecycle] auto cleanup ${result.cleanupRunId}: freed ${result.bytesFreed} bytes (${result.applied} actions)`,
        );
      } catch (error) {
        this.log.warn(`[lifecycle] auto cleanup failed: ${String(error)}`);
      }
    };
    this.initialCleanupTimer = setTimeout(run, this.options.autoCleanupInitialDelayMs ?? 60_000);
    this.cleanupInterval = setInterval(run, this.options.autoCleanupIntervalMs);
    this.initialCleanupTimer.unref?.();
    this.cleanupInterval.unref?.();
  }

  async stop(): Promise<void> {
    if (!this.started) {
      await this.options.managedRuntime?.stop();
      return;
    }
    this.started = false;
    if (this.initialCleanupTimer) clearTimeout(this.initialCleanupTimer);
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    this.initialCleanupTimer = undefined;
    this.cleanupInterval = undefined;
    this.options.scheduler.stop();
    await this.options.managedRuntime?.stop();
  }

  status(): { started: boolean; autoCleanupScheduled: boolean } {
    return {
      started: this.started,
      autoCleanupScheduled: Boolean(this.initialCleanupTimer || this.cleanupInterval),
    };
  }
}

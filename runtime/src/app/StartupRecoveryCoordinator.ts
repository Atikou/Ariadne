import type { ShutdownContext } from '../ingress/ShutdownContext.js';

export interface StartupRecoveryTask {
  /** Stable internal identity used for diagnostics; never contains user data. */
  readonly name: string;
  /** Implementations must observe cancellation and settle before stores close. */
  run(signal: AbortSignal): Promise<void>;
}

interface StartupRecoveryTaskOutcome {
  readonly name: string;
  readonly error?: unknown;
}

export type StartupRecoveryState =
  | 'new'
  | 'recovering'
  | 'ready'
  | 'failed'
  | 'stopping'
  | 'stopped';

export class StartupRecoveryError extends Error {
  public constructor(
    public readonly code:
      | 'STARTUP_RECOVERY_FAILED'
      | 'STARTUP_RECOVERY_CANCELLED'
      | 'STARTUP_RECOVERY_REGISTRATION_CLOSED',
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'StartupRecoveryError';
  }
}

/**
 * Owns every required startup-recovery producer. Readiness waits for all
 * producers, while shutdown aborts their shared signal and joins the complete
 * producer group before any store is allowed to close.
 */
export class StartupRecoveryCoordinator {
  private readonly tasks: StartupRecoveryTask[] = [];
  private readonly controller = new AbortController();
  private lifecycle: StartupRecoveryState = 'new';
  private startOperation: Promise<void> | null = null;
  private joinOperation: Promise<readonly StartupRecoveryTaskOutcome[]> | null = null;
  private shutdownOperation: Promise<void> | null = null;

  public register(task: StartupRecoveryTask): void {
    if (this.lifecycle !== 'new') {
      throw new StartupRecoveryError(
        'STARTUP_RECOVERY_REGISTRATION_CLOSED',
        'Startup recovery registration is closed.'
      );
    }
    assertTask(task);
    if (this.tasks.some((candidate) => candidate.name === task.name)) {
      throw new StartupRecoveryError(
        'STARTUP_RECOVERY_REGISTRATION_CLOSED',
        `Startup recovery task "${task.name}" is already registered.`
      );
    }
    this.tasks.push({ name: task.name, run: task.run });
  }

  /** The application must await this operation before reporting ready. */
  public start(): Promise<void> {
    if (this.startOperation !== null) return this.startOperation;
    if (this.lifecycle !== 'new') {
      return Promise.reject(new StartupRecoveryError(
        'STARTUP_RECOVERY_CANCELLED',
        'Startup recovery cannot start after shutdown.'
      ));
    }
    this.lifecycle = 'recovering';
    const signal = this.controller.signal;
    this.joinOperation = Promise.all(this.tasks.map(async (task) => {
      try {
        signal.throwIfAborted();
        await task.run(signal);
        signal.throwIfAborted();
        return { name: task.name };
      } catch (error) {
        return { name: task.name, error };
      }
    }));
    this.startOperation = this.finishStartup(this.joinOperation);
    return this.startOperation;
  }

  /** Cancels new recovery work and joins every admitted producer. */
  public prepareShutdown(context: ShutdownContext): Promise<void> {
    this.shutdownOperation ??= this.stopAndJoin(context);
    return this.shutdownOperation;
  }

  public state(): StartupRecoveryState {
    return this.lifecycle;
  }

  private async finishStartup(
    join: Promise<readonly StartupRecoveryTaskOutcome[]>
  ): Promise<void> {
    const outcomes = await join;
    if (this.controller.signal.aborted) {
      if (this.lifecycle !== 'stopped') this.lifecycle = 'stopping';
      throw new StartupRecoveryError(
        'STARTUP_RECOVERY_CANCELLED',
        'Startup recovery was cancelled before readiness.'
      );
    }
    const failures = outcomes.filter(
      (outcome): outcome is StartupRecoveryTaskOutcome & { readonly error: unknown } =>
        Object.prototype.hasOwnProperty.call(outcome, 'error')
    );
    if (failures.length > 0) {
      this.lifecycle = 'failed';
      throw new StartupRecoveryError(
        'STARTUP_RECOVERY_FAILED',
        `Required startup recovery failed: ${failures.map((item) => item.name).join(',')}.`,
        {
          cause: new AggregateError(
            failures.map((item) => item.error),
            'startup_recovery_task_failures'
          )
        }
      );
    }
    this.lifecycle = 'ready';
  }

  private async stopAndJoin(context: ShutdownContext): Promise<void> {
    context.throwIfExpired('startup_recovery_shutdown_deadline_exceeded');
    if (this.lifecycle !== 'stopped') this.lifecycle = 'stopping';
    if (!this.controller.signal.aborted) {
      this.controller.abort(new Error('startup_recovery_shutdown_requested'));
    }
    const join = this.joinOperation;
    if (join !== null) {
      await joinWithinShutdown(join, context);
    }
    this.lifecycle = 'stopped';
  }
}

function assertTask(task: StartupRecoveryTask): void {
  if (
    typeof task !== 'object'
    || task === null
    || Array.isArray(task)
    || Object.getPrototypeOf(task) !== Object.prototype
    || Object.keys(task).length !== 2
    || !Object.prototype.hasOwnProperty.call(task, 'name')
    || !Object.prototype.hasOwnProperty.call(task, 'run')
    || typeof task.name !== 'string'
    || !/^[a-z][a-z0-9_.-]{0,127}$/u.test(task.name)
    || typeof task.run !== 'function'
  ) {
    throw new StartupRecoveryError(
      'STARTUP_RECOVERY_REGISTRATION_CLOSED',
      'Startup recovery task is invalid.'
    );
  }
}

async function joinWithinShutdown(
  join: Promise<readonly StartupRecoveryTaskOutcome[]>,
  context: ShutdownContext
): Promise<void> {
  context.throwIfExpired('startup_recovery_shutdown_deadline_exceeded');
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    const fail = (): void => reject(
      new Error('startup_recovery_shutdown_deadline_exceeded')
    );
    onAbort = fail;
    if (context.signal.aborted) fail();
    else context.signal.addEventListener('abort', fail, { once: true });
  });
  try {
    await Promise.race([join, deadline]);
  } finally {
    if (onAbort !== undefined) context.signal.removeEventListener('abort', onAbort);
  }
  context.throwIfExpired('startup_recovery_shutdown_deadline_exceeded');
}

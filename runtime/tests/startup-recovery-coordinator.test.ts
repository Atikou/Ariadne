import { describe, expect, it } from 'vitest';

import {
  StartupRecoveryCoordinator
} from '../src/app/StartupRecoveryCoordinator.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';

describe('StartupRecoveryCoordinator', () => {
  it('keeps application readiness behind every required recovery producer', async () => {
    const coordinator = new StartupRecoveryCoordinator();
    const started = deferred<void>();
    const release = deferred<void>();
    let applicationReady = false;
    coordinator.register({
      name: 'plan_agent_continuations',
      run: async () => {
        started.resolve();
        await release.promise;
      }
    });
    coordinator.register({
      name: 'companion_session_deletion',
      run: async () => undefined
    });

    const applicationStart = coordinator.start().then(() => {
      applicationReady = true;
    });
    await started.promise;
    await Promise.resolve();
    expect(applicationReady).toBe(false);
    expect(coordinator.state()).toBe('recovering');

    release.resolve();
    await applicationStart;
    expect(applicationReady).toBe(true);
    expect(coordinator.state()).toBe('ready');
  });

  it('aborts and joins the entire producer group before prepareShutdown resolves', async () => {
    const coordinator = new StartupRecoveryCoordinator();
    const started = deferred<void>();
    const observedAbort = deferred<void>();
    const releaseJoin = deferred<void>();
    let producerActive = false;
    coordinator.register({
      name: 'plan_agent_continuations',
      run: async (signal) => {
        producerActive = true;
        started.resolve();
        await waitForAbort(signal);
        observedAbort.resolve();
        await releaseJoin.promise;
        producerActive = false;
      }
    });

    const start = coordinator.start();
    const startFailure = expect(start).rejects.toMatchObject({
      code: 'STARTUP_RECOVERY_CANCELLED'
    });
    await started.promise;
    const context = createShutdownContext(Date.now() + 5_000);
    try {
      let shutdownSettled = false;
      const shutdown = coordinator.prepareShutdown(context).then(() => {
        shutdownSettled = true;
      });
      await observedAbort.promise;
      await Promise.resolve();
      expect(shutdownSettled).toBe(false);
      expect(producerActive).toBe(true);
      expect(coordinator.state()).toBe('stopping');

      releaseJoin.resolve();
      await shutdown;
      await startFailure;
      expect(producerActive).toBe(false);
      expect(coordinator.state()).toBe('stopped');
    } finally {
      context.dispose();
    }
  });

  it('fails closed when any required recovery fails', async () => {
    const coordinator = new StartupRecoveryCoordinator();
    let siblingCompleted = false;
    coordinator.register({
      name: 'plan_agent_continuations',
      run: async () => {
        throw new Error('simulated_recovery_failure');
      }
    });
    coordinator.register({
      name: 'companion_session_deletion',
      run: async () => {
        siblingCompleted = true;
      }
    });

    await expect(coordinator.start()).rejects.toMatchObject({
      code: 'STARTUP_RECOVERY_FAILED'
    });
    expect(siblingCompleted).toBe(true);
    expect(coordinator.state()).toBe('failed');
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

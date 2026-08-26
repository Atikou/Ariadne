import {
  ARIADNE_RUNTIME_PROTOCOL,
  ARIADNE_RUNTIME_PROTOCOL_VERSION,
  type RuntimeCancel,
  type RuntimeRequest,
  type RuntimeResponse,
  type RuntimeShutdown
} from '@ariadne/protocol/host';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  RuntimeCommandEnvelope,
  RuntimeIngress,
  RuntimeIngressCommandStatus,
  RuntimeIngressInitialization,
  RuntimeIngressReady
} from '../src/ingress/RuntimeIngress.js';
import type { ShutdownContext } from '../src/ingress/ShutdownContext.js';
import { NodeIpcRuntimeHost } from '../src/transport/NodeIpcRuntimeHost.js';

afterEach(() => {
  process.exitCode = undefined;
});

describe('NodeIpcRuntimeHost transport lifecycle', () => {
  it('tracks an accepted transport attempt until Ingress settles', async () => {
    let resolveRequest!: (outcome: RuntimeResponse['outcome']) => void;
    const ingress = new TestRuntimeIngress(() => new Promise((resolve) => {
      resolveRequest = resolve;
    }));
    const host = new NodeIpcRuntimeHost(ingress);
    const send = activate(host);
    const internals = hostInternals(host);

    internals.acceptRequest(request('request-1'));
    expect(internals.inFlight.size).toBe(1);
    let drained = false;
    const drain = internals.drainInFlight(Date.now() + 5_000).then((result) => {
      drained = result;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    resolveRequest(successOutcome());
    await drain;

    expect(drained).toBe(true);
    expect(internals.inFlight.size).toBe(0);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'response',
      requestId: 'request-1',
      commandId: 'command-request-1',
      outcome: expect.objectContaining({ ok: true })
    }));
  });

  it('honors the drain deadline when accepted Ingress work cannot settle', async () => {
    const ingress = new TestRuntimeIngress(() => new Promise(() => undefined));
    const host = new NodeIpcRuntimeHost(ingress);
    activate(host);
    const internals = hostInternals(host);
    internals.acceptRequest(request('request-never-settles'));

    const startedAt = Date.now();
    const drained = await internals.drainInFlight(startedAt + 20);

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(drained).toBe(false);
    expect(internals.inFlight.size).toBe(1);
  });

  it('persists interruption through Ingress before aborting the attempt', async () => {
    const order: string[] = [];
    const uncertain = uncertainOutcome('command-cancelled');
    const ingress = new TestRuntimeIngress((_envelope) => (
      new Promise((resolve) => {
        _envelope.signal.addEventListener('abort', () => {
          order.push('attempt-aborted');
          resolve(uncertain);
        }, { once: true });
      })
    ));
    ingress.onInterrupt = () => {
      order.push('journal-uncertain');
      return uncertain;
    };
    const host = new NodeIpcRuntimeHost(ingress);
    const send = activate(host);
    const internals = hostInternals(host);

    internals.acceptRequest(request('request-cancelled', 'command-cancelled'));
    internals.cancelCommand(cancel('request-cancelled', 'command-cancelled'));
    await vi.waitFor(() => expect(internals.inFlight.size).toBe(0));

    expect(order).toEqual(['journal-uncertain', 'attempt-aborted']);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'cancel_acknowledged',
      status: 'accepted'
    }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'response',
      outcome: uncertain
    }));
  });

  it('never cancels a newer attempt when a stale cancel arrives', () => {
    const ingress = new TestRuntimeIngress(() => new Promise(() => undefined));
    ingress.onInterrupt = vi.fn(() => uncertainOutcome('stable-command'));
    const host = new NodeIpcRuntimeHost(ingress);
    const send = activate(host);
    const internals = hostInternals(host);

    internals.acceptRequest(request('request-current', 'stable-command'));
    internals.cancelCommand(cancel('request-old', 'stable-command'));

    expect(internals.inFlight.size).toBe(1);
    expect(ingress.onInterrupt).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'cancel_acknowledged',
      status: 'attempt_mismatch'
    }));
  });

  it('drains cancelled attempts before delegating shutdown to Ingress', async () => {
    const order: string[] = [];
    const ingress = new TestRuntimeIngress((envelope) => (
      new Promise((resolve) => {
        envelope.signal.addEventListener('abort', () => {
          order.push('request-drained');
          resolve(uncertainOutcome(envelope.correlationId));
        }, { once: true });
      })
    ));
    ingress.onInterrupt = (commandId) => uncertainOutcome(commandId);
    ingress.onShutdown = async () => {
      order.push('ingress-shutdown');
    };
    const host = new NodeIpcRuntimeHost(ingress);
    activate(host);
    const internals = hostInternals(host);

    internals.acceptRequest(request('request-shutdown', 'command-shutdown'));
    await internals.stopRuntime(Date.now() + 5_000);

    expect(order).toEqual(['request-drained', 'ingress-shutdown']);
  });

  it('does not invoke Ingress shutdown when accepted work misses the drain deadline', async () => {
    const ingress = new TestRuntimeIngress(() => new Promise(() => undefined));
    ingress.onInterrupt = (commandId) => uncertainOutcome(commandId);
    ingress.onShutdown = vi.fn(async () => undefined);
    const host = new NodeIpcRuntimeHost(ingress);
    activate(host);
    const internals = hostInternals(host);
    internals.acceptRequest(request('request-stuck', 'command-stuck'));

    await expect(internals.stopRuntime(Date.now() + 20)).rejects.toThrow(
      'runtime_shutdown_inflight_deadline_exceeded'
    );
    expect(ingress.onShutdown).not.toHaveBeenCalled();
  });

  it('does not acknowledge or disconnect when Ingress shutdown is uncertain', async () => {
    const ingress = new TestRuntimeIngress(async () => successOutcome());
    ingress.onShutdown = vi.fn(() => new Promise<void>(() => undefined));
    const host = new NodeIpcRuntimeHost(ingress);
    const send = activate(host);
    const internals = hostInternals(host);

    void internals.shutdown({
      protocol: ARIADNE_RUNTIME_PROTOCOL,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: 'runtime-instance-1',
      type: 'shutdown',
      requestId: 'shutdown-deadline',
      reason: 'user_request',
      deadlineAt: new Date(Date.now() + 20).toISOString()
    });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(ingress.onShutdown).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'shutdown_complete'
    }));
  });
});

class TestRuntimeIngress implements RuntimeIngress {
  public readonly statuses = new Map<string, RuntimeIngressCommandStatus>();
  public onInterrupt: (
    commandId: string,
    reason: RuntimeCancel['reason']
  ) => RuntimeResponse['outcome'] | null = () => null;
  public onShutdown: (context: ShutdownContext) => Promise<void> = async () => undefined;

  public constructor(
    private readonly onExecute: (
      envelope: RuntimeCommandEnvelope
    ) => Promise<RuntimeResponse['outcome']>
  ) {}

  public initialize(
    _input: RuntimeIngressInitialization
  ): Promise<RuntimeIngressReady> {
    throw new Error('not_used');
  }

  public execute(envelope: RuntimeCommandEnvelope): Promise<RuntimeResponse['outcome']> {
    this.statuses.set(envelope.commandId, 'executing');
    return this.onExecute(envelope).then((outcome) => {
      this.statuses.set(envelope.commandId, outcome.ok ? 'completed' : 'uncertain');
      return outcome;
    });
  }

  public getCommandStatus(commandId: string): RuntimeIngressCommandStatus | null {
    return this.statuses.get(commandId) ?? null;
  }

  public interrupt(
    commandId: string,
    reason: RuntimeCancel['reason']
  ): RuntimeResponse['outcome'] | null {
    const outcome = this.onInterrupt(commandId, reason);
    if (outcome) this.statuses.set(commandId, 'uncertain');
    return outcome;
  }

  public shutdown(context: ShutdownContext): Promise<void> {
    return this.onShutdown(context);
  }
}

function hostInternals(host: NodeIpcRuntimeHost): {
  inFlight: Map<string, unknown>;
  acceptRequest(request: RuntimeRequest): void;
  cancelCommand(message: RuntimeCancel): void;
  drainInFlight(deadline: number): Promise<boolean>;
  stopRuntime(deadline: number): Promise<void>;
  shutdown(message: RuntimeShutdown): Promise<void>;
} {
  return host as unknown as ReturnType<typeof hostInternals>;
}

function activate(host: NodeIpcRuntimeHost): ReturnType<typeof vi.fn> {
  const send = vi.fn();
  const internals = host as unknown as {
    initialized: boolean;
    bootstrap: { runtimeInstanceId: string };
    send(message: unknown): void;
  };
  internals.initialized = true;
  internals.bootstrap = { runtimeInstanceId: 'runtime-instance-1' };
  internals.send = send;
  return send;
}

function request(requestId: string, commandId = `command-${requestId}`): RuntimeRequest {
  return {
    protocol: ARIADNE_RUNTIME_PROTOCOL,
    protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
    runtimeInstanceId: 'runtime-instance-1',
    type: 'request',
    requestId,
    commandId,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    command: { kind: 'runtime.status.get' }
  };
}

function cancel(targetRequestId: string, commandId: string): RuntimeCancel {
  return {
    protocol: ARIADNE_RUNTIME_PROTOCOL,
    protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
    runtimeInstanceId: 'runtime-instance-1',
    type: 'cancel',
    cancelRequestId: `cancel-${targetRequestId}`,
    targetRequestId,
    commandId,
    reason: 'caller_cancelled'
  };
}

function successOutcome(): RuntimeResponse['outcome'] {
  return {
    ok: true,
    result: {
      kind: 'runtime.status',
      status: {
        availability: 'ready',
        capabilities: [],
        observedAt: new Date().toISOString()
      }
    }
  };
}

function uncertainOutcome(correlationId: string): RuntimeResponse['outcome'] {
  return {
    ok: false,
    error: {
      code: 'command_outcome_uncertain',
      message: 'Outcome is uncertain.',
      retryable: false,
      correlationId
    }
  };
}

import { randomUUID } from 'node:crypto';

import {
  ARIADNE_RUNTIME_PROTOCOL,
  ARIADNE_RUNTIME_PROTOCOL_VERSION,
  type HostCapabilityOperation,
  type HostCapabilityResponse
} from '@ariadne/protocol/host';

import type { HostCapabilityClient } from '../ingress/HostCapabilityClient.js';

/** IPC adapter for private capabilities owned by Electron Main. */
export class IpcHostCapabilityClient implements HostCapabilityClient {
  private readonly pending = new Map<string, {
    resolve(value: Record<string, unknown>): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }>();

  public constructor(
    private readonly runtimeInstanceId: string,
    private readonly send: (message: unknown) => void
  ) {}

  public request(
    operation: HostCapabilityOperation,
    timeoutMs = 30_000
  ): Promise<Record<string, unknown>> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`host_capability_timeout:${operation.kind}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, timer });
      this.send({
        protocol: ARIADNE_RUNTIME_PROTOCOL,
        protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
        runtimeInstanceId: this.runtimeInstanceId,
        type: 'capability_request',
        requestId,
        capability: capabilityForOperation(operation),
        operation
      });
    });
  }

  public accept(response: HostCapabilityResponse): boolean {
    const pending = this.pending.get(response.requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(response.requestId);
    if (response.outcome.ok) pending.resolve(response.outcome.result);
    else {
      pending.reject(new Error(
        `${response.outcome.error.code}:${response.outcome.error.message}`
      ));
    }
    return true;
  }

  public close(reason = 'host_capability_client_closed'): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }
}

function capabilityForOperation(
  operation: HostCapabilityOperation
): 'computer_read' | 'browser' | 'mcp_remote' | 'agent_persistence' | 'credential' {
  if (operation.kind.startsWith('computer.')) return 'computer_read';
  if (operation.kind.startsWith('mcp.remote.')) return 'mcp_remote';
  if (operation.kind === 'agent.persistence.keyring.read') {
    return 'agent_persistence';
  }
  if (operation.kind.startsWith('credential.')) return 'credential';
  return 'browser';
}

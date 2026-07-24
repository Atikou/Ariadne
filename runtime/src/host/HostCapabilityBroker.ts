import { randomUUID } from "node:crypto";

import {
  ARIADNE_RUNTIME_PROTOCOL,
  ARIADNE_RUNTIME_PROTOCOL_VERSION,
  type HostCapabilityOperation,
  type HostCapabilityResponse,
} from "@ariadne/protocol/host";

export interface HostCapabilityBroker {
  request(operation: HostCapabilityOperation, timeoutMs?: number): Promise<Record<string, unknown>>;
}

export class IpcHostCapabilityBroker implements HostCapabilityBroker {
  private readonly pending = new Map<string, {
    resolve(value: Record<string, unknown>): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }>();

  constructor(
    private readonly runtimeInstanceId: string,
    private readonly send: (message: unknown) => void,
  ) {}

  request(
    operation: HostCapabilityOperation,
    timeoutMs = 30_000,
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
        type: "capability_request",
        requestId,
        capability: operation.kind.startsWith("mcp.remote.") ? "mcp_remote" : "browser",
        operation,
      });
    });
  }

  accept(response: HostCapabilityResponse): boolean {
    const pending = this.pending.get(response.requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(response.requestId);
    if (response.outcome.ok) pending.resolve(response.outcome.result);
    else pending.reject(new Error(
      `${response.outcome.error.code}:${response.outcome.error.message}`,
    ));
    return true;
  }

  close(reason = "host_capability_broker_closed"): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }
}

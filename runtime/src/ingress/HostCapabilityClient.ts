import type { HostCapabilityOperation } from '@ariadne/protocol/host';

/**
 * Runtime-side request port for private capabilities owned by Electron Main.
 * Implementations belong to transport; Control and composition depend only on
 * this ingress contract.
 */
export interface HostCapabilityClient {
  request(
    operation: HostCapabilityOperation,
    timeoutMs?: number
  ): Promise<Record<string, unknown>>;
}

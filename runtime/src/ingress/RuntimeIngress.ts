import type {
  RuntimeBootstrap,
  RuntimeCancel,
  RuntimeResponse
} from '@ariadne/protocol/host';
import type {
  RuntimeCommand,
  RuntimeEventEnvelope,
  RuntimeStatus
} from '@ariadne/protocol/public';

import type { HostCapabilityClient } from './HostCapabilityClient.js';
import type { ShutdownContext } from './ShutdownContext.js';

export interface RuntimeIngressInitialization {
  readonly bootstrap: RuntimeBootstrap;
  readonly hostCapabilities?: HostCapabilityClient;
  readonly emitEvent: (event: RuntimeEventEnvelope) => void;
}

export interface RuntimeIngressReady {
  readonly runtimeVersion: string;
  readonly runtimeBuildFingerprint: string;
  readonly status: RuntimeStatus;
  readonly storageSchemas: Readonly<Record<string, number>>;
}

/**
 * One logical command at the Runtime boundary. `commandId` owns durable
 * idempotency; `correlationId` is safe to expose in the caller-facing error.
 */
export interface RuntimeCommandEnvelope {
  readonly commandId: string;
  readonly correlationId: string;
  readonly command: RuntimeCommand;
  readonly deadlineAt: string;
  readonly signal: AbortSignal;
}

export type RuntimeIngressCommandStatus =
  | 'executing'
  | 'completed'
  | 'uncertain';

/**
 * The only business-facing port exposed to Runtime transports.
 *
 * Implementations own bootstrap validation, persistence admission, business
 * composition, recovery and resource shutdown. A transport owns only framing,
 * attempt cancellation and its in-flight request table.
 */
export interface RuntimeIngress {
  initialize(input: RuntimeIngressInitialization): Promise<RuntimeIngressReady>;
  execute(envelope: RuntimeCommandEnvelope): Promise<RuntimeResponse['outcome']>;
  getCommandStatus(commandId: string): RuntimeIngressCommandStatus | null;
  interrupt(
    commandId: string,
    reason: RuntimeCancel['reason']
  ): RuntimeResponse['outcome'] | null;
  shutdown(context: ShutdownContext): Promise<void>;
}

/** Safe startup failure projected by Composition for protocol adapters. */
export class RuntimeIngressInitializationError extends Error {
  public constructor(
    public readonly phase: string,
    public readonly code: string,
    public readonly publicMessage: string,
    options?: ErrorOptions
  ) {
    super(publicMessage, options);
    this.name = 'RuntimeIngressInitializationError';
  }
}

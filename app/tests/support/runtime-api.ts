import type {
  RuntimeCommand,
  RuntimeEventEnvelope,
  RuntimeResult,
  RuntimeStatus
} from '@ariadne/protocol/public';
import type {
  AriadneApi,
  Result,
  RuntimeDesktopRequestOptions
} from '@shared/contract';

export interface RuntimeApiBehavior {
  getStatus(): Promise<RuntimeStatus>;
  onStatus?(listener: (status: RuntimeStatus) => void): () => void;
  request(
    command: RuntimeCommand,
    options?: RuntimeDesktopRequestOptions
  ): Promise<RuntimeResult>;
  onEvent(listener: (event: RuntimeEventEnvelope) => void): () => void;
}

export function successfulRuntimeApi(behavior: RuntimeApiBehavior): AriadneApi['runtime'] {
  return {
    getStatus: () => capture(() => behavior.getStatus()),
    onStatus: (listener) => behavior.onStatus?.(listener) ?? (() => undefined),
    request: (command, options) => capture(() => behavior.request(command, options)),
    onEvent: (listener) => behavior.onEvent(listener)
  };
}

async function capture<T>(operation: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'test_runtime_error',
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
        correlationId: 'test-correlation'
      }
    };
  }
}

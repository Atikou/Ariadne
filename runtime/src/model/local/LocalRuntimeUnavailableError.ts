/** Produced only by the embedded process owner at observed transport, exit
 * or model-loading boundaries. Private worker details stay in the cause. */
export class LocalRuntimeUnavailableError extends Error {
  public constructor(public readonly code: 'local_worker_transport_failed' | 'local_worker_exited' | 'local_model_load_failed',
    cause: unknown) { super(code, { cause }); this.name = 'LocalRuntimeUnavailableError'; }
}

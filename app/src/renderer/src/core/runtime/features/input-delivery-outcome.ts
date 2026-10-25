import { PublicResultError } from '../public-result';

const UNCERTAIN = new Set(['command_outcome_uncertain', 'runtime_request_timeout', 'runtime_request_cancelled', 'runtime_request_send_failed']);
const DEFERRED = new Set(['runtime_unavailable', 'runtime_initializing', 'runtime_shutting_down', 'runtime_stopped', 'runtime_exited']);

/** Only a correlated, well-formed negative result proves rejection. A broken
 * response after dispatch cannot safely become a fresh editable submission. */
export function shouldReconcileInput(error: unknown, commandId: string, retry: boolean): boolean {
  if (!(error instanceof PublicResultError)) return true;
  const { code, correlationId } = error.publicError;
  if (correlationId !== undefined && correlationId !== commandId) return true;
  return UNCERTAIN.has(code) || (retry && DEFERRED.has(code));
}

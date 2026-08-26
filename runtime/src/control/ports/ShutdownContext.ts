/**
 * Neutral absolute-deadline contract shared by lifecycle orchestration and
 * persistence ports. Construction and timers remain outside adapters.
 */
export interface ShutdownContext {
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  remainingMs(reserveMs?: number): number;
  throwIfExpired(code?: string): void;
}

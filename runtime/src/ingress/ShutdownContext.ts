import type { ShutdownContext } from '../control/ports/ShutdownContext.js';

export type { ShutdownContext } from '../control/ports/ShutdownContext.js';

export interface ShutdownContextHandle extends ShutdownContext {
  dispose(): void;
}

export function createShutdownContext(
  deadlineAt: number,
  parentSignal?: AbortSignal,
): ShutdownContextHandle {
  if (!Number.isFinite(deadlineAt)) throw new Error("shutdown_deadline_invalid");
  const controller = new AbortController();
  const abort = (): void => controller.abort(parentSignal?.reason ?? new Error("shutdown_aborted"));
  if (parentSignal?.aborted) abort();
  else parentSignal?.addEventListener("abort", abort, { once: true });

  const timeoutMs = Math.max(0, deadlineAt - Date.now());
  const timer = setTimeout(() => {
    controller.abort(new Error("shutdown_deadline_exceeded"));
  }, Math.min(2_147_483_647, timeoutMs));
  timer.unref?.();

  return {
    deadlineAt,
    signal: controller.signal,
    remainingMs(reserveMs = 0): number {
      return Math.max(0, deadlineAt - Date.now() - Math.max(0, reserveMs));
    },
    throwIfExpired(code = "shutdown_deadline_exceeded"): void {
      if (Date.now() >= deadlineAt || controller.signal.aborted) throw new Error(code);
    },
    dispose(): void {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abort);
    },
  };
}

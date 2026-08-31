import type { ComponentLifecycle } from './types.js';

export interface StartedComponent<TShutdownContext> {
  readonly handle: ComponentLifecycle<TShutdownContext>;
}

/** Invoke lifecycle hooks in dependency-safe reverse start order and collect every failure. */
export async function invokeComponentLifecycleReverse<TShutdownContext>(
  started: readonly StartedComponent<TShutdownContext>[],
  context: TShutdownContext,
  method: 'prepareShutdown' | 'close',
  assertActive?: (context: TShutdownContext) => void
): Promise<readonly unknown[]> {
  const failures: unknown[] = [];
  for (const item of [...started].reverse()) {
    try {
      assertActive?.(context);
      await item.handle[method]?.(context);
    } catch (error) {
      failures.push(error);
    }
  }
  return Object.freeze(failures);
}

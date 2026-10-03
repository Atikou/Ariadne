import { AgentRunWorkSchedulerShutdownError } from './AgentRunWorkSchedulerContracts.js';

export function uniquePromises(
  values: readonly (Promise<unknown> | null)[]
): Promise<unknown>[] {
  const unique: Promise<unknown>[] = [];
  for (const value of values) {
    if (value !== null && !unique.includes(value)) unique.push(value);
  }
  return unique;
}

export function joinBeforeDeadline(
  operation: Promise<unknown>,
  remainingMs: number
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new AgentRunWorkSchedulerShutdownError());
    }, Math.min(remainingMs, 2_147_483_647));
    timeout.unref?.();
    operation.then(
      () => { clearTimeout(timeout); resolve(); },
      () => { clearTimeout(timeout); resolve(); }
    );
  });
}

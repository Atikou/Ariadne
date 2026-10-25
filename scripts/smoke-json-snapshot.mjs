import { renameSync, writeFileSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';

/** Publish a complete, replaceable observation. Readers retain the previous
 * valid JSON while Windows temporarily denies replacement of an open file.
 * Coalescing retains one latest snapshot; failure is explicit and bounded. */
export function createSmokeJsonSnapshotWriter(target, { replace = renameSync, retryMs = 10, timeoutMs = 5_000 } = {}) {
  const temporary = `${target}.${process.pid}.tmp`;
  let pending = null, active = null;
  async function flush() {
    const deadline = Date.now() + timeoutMs;
    while (pending !== null) {
      const json = pending;
      writeFileSync(temporary, json, 'utf8');
      try { replace(temporary, target); pending = null; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || Date.now() >= deadline) throw error;
        await wait(Math.min(retryMs, Math.max(1, deadline - Date.now())));
      }
    }
  }
  return {
    write(value) {
      pending = JSON.stringify(value, null, 2);
      if (active === null) {
        let resolve, reject;
        active = new Promise((done, fail) => { resolve = done; reject = fail; });
        const drain = () => {
          void flush().then(() => {
            // A write may arrive while the async flush promise is settling.
            // Finish admission and delivery together before resolving callers.
            if (pending !== null) { drain(); return; }
            active = null; resolve();
          }, error => { pending = null; active = null; reject(error); });
        };
        queueMicrotask(drain);
      }
      return active;
    }
  };
}

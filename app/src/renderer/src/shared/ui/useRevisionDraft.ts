import { useState } from 'react';

/** The editing baseline is immutable until an explicit reload/rebase or an
 * acknowledged command. A refreshed server revision never replaces dirty input. */
export function useRevisionDraft<T>(server: T, revision: string) {
  const [stored, setStored] = useState({ value: server, baseline: server, revision, dirty: false });
  let draft = stored;
  if (!stored.dirty && stored.revision !== revision) {
    draft = { value: server, baseline: server, revision, dirty: false };
    setStored(draft);
  }
  return {
    ...draft,
    conflict: draft.dirty && draft.revision !== revision,
    edit(value: T): void {
      setStored(current => {
        const baseline = current.dirty ? current.baseline : server;
        return { value, baseline, revision: current.dirty ? current.revision : revision,
          dirty: JSON.stringify(value) !== JSON.stringify(baseline) };
      });
    },
    reload(): void { setStored({ value: server, baseline: server, revision, dirty: false }); },
    rebase(merge?: (local: T, currentServer: T) => T): void {
      setStored(current => {
        const value = merge ? merge(current.value, server) : current.value;
        return { value, baseline: server, revision, dirty: JSON.stringify(value) !== JSON.stringify(server) };
      });
    },
    committed(): void { setStored(current => ({ ...current, dirty: false })); }
  };
}

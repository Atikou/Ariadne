import { basename, dirname, isAbsolute, join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { observeWindowsParentExit, type ObservedParentExit } from './windows-parent-exit-observer';

/** A Main that creates original profile owners, and the post-exit directory
 * switch helper, share this actual Windows file lease. Recovery UI uses a
 * separate profile and never opens the original owners. The OS releases the
 * lease on process death; no stale PID file is treated as an ownership grant. */
export async function acquireDataRootOwnerLease(dataRoot: string): Promise<ObservedParentExit> {
  if (!isAbsolute(dataRoot)) throw new Error('restore_owner_root_invalid');
  const parent = await realpath(dirname(dataRoot));
  return observeWindowsParentExit(process.pid, join(parent, '.' + basename(dataRoot) + '.ariadne-owner.lock'), { lifetime: 'owner-process' });
}

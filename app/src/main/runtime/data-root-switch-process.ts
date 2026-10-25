import { basename, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { dataRootSwitchArmSchema as armSchema, dataRootSwitchPrepareSchema as prepareSchema } from './data-root-switch-contract';
import type { z } from 'zod';
import { archiveSettledDataRootSwitch, dataRootCandidateName, inspectDataRootSwitch, settleDataRootSwitch } from '../data-management/data-root-switch-journal';
import { verifyRestoreCandidate } from '../data-management/restore-candidate';
import { observeWindowsParentExit } from './windows-parent-exit-observer';
import { acquireDataRootOwnerLease } from './data-root-owner-lease';

/** Separate Node owner bundled beside Main. It has no Electron profile, Actor,
 * model, tool or notification startup. Only the parent that launched this IPC
 * channel can arm its already prepared journal. */
if (!process.send || process.platform !== 'win32') process.exit(1);
let preparation: z.infer<typeof prepareSchema> | null = null, armed = false, ready = false;
const timer = setTimeout(() => process.exit(1), 310_000);
process.on('message', (raw: unknown) => {
  if (raw && typeof raw === 'object' && 'type' in raw && raw.type === 'arm') {
    const arm = armSchema.safeParse(raw);
    if (!arm.success || !ready || armed || arm.data.operationId !== preparation?.operationId) { process.exit(1); return; }
    armed = true;
    process.send?.({ protocol: 'ariadne_data_root_switch.v1', type: 'armed', operationId: preparation.operationId });
    return;
  }
  if (preparation) { process.exit(1); return; }
  const input = prepareSchema.safeParse(raw);
  if (!input.success) { process.exit(1); return; }
  preparation = input.data;
  void run(input.data).then(() => process.exit(0)).catch(() => process.exit(1));
});

async function run(input: z.infer<typeof prepareSchema>): Promise<void> {
  const inspection = await inspectDataRootSwitch(input.dataRoot);
  if (!inspection || inspection.journal.operationId !== input.operationId || !inspection.choices.includes(input.choice))
    throw new Error('restore_switch_prepare_invalid');
  const observer = await observeWindowsParentExit(process.ppid,
    join(dirname(input.dataRoot), '.' + basename(input.dataRoot) + '.ariadne-switch.lock'));
  try {
    const locked = await inspectDataRootSwitch(input.dataRoot);
    if (!locked || locked.journal.operationId !== input.operationId || !locked.choices.includes(input.choice)) throw new Error('restore_switch_prepare_changed');
    ready = true;
    process.send?.({ protocol: 'ariadne_data_root_switch.v1', type: 'ready', operationId: input.operationId });
    const exitCode = await observer.exited;
    if (!armed || exitCode !== 0) throw new Error('restore_parent_not_clean');
    // The old Main's lease holder also exits asynchronously. Retry only this
    // concrete OS handoff; never bypass an owner that still holds the lease.
    let lease: Awaited<ReturnType<typeof acquireDataRootOwnerLease>> | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { lease = await acquireDataRootOwnerLease(input.dataRoot); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    if (!lease) throw new Error('restore_source_owner_still_active');
    try {
      if (input.choice === 'replacement') {
        const candidate = join(dirname(input.dataRoot), dataRootCandidateName(basename(input.dataRoot), input.operationId));
        await verifyRestoreCandidate(locked.current === 'replacement' ? input.dataRoot : candidate,
          locked.journal.backupId, locked.journal.inventorySha256, candidate);
      }
      await settleDataRootSwitch(input.dataRoot, input.choice);
      await archiveSettledDataRootSwitch(input.dataRoot);
    } finally { await lease.release(); }
    clearTimeout(timer);
    if (input.relaunch) {
      const child = spawn(input.relaunch.executable, input.relaunch.packaged ? [] : [input.relaunch.appPath],
        { detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
      child.on('error', () => undefined); child.unref();
    }
  } finally { observer.dispose(); }
}

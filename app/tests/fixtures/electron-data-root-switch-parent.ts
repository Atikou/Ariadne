import { app } from 'electron';
import { realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { prepareDataRootSwitchWorker } from '../../src/main/runtime/data-root-switch-worker';
import { acquireDataRootOwnerLease } from '../../src/main/runtime/data-root-owner-lease';

const [root, operationId, executable, entry] = process.argv.slice(2);
if (!process.send || !root || !operationId || !executable || !entry) process.exit(1);
const parent = realpathSync(dirname(root!)), temp = statSync(tmpdir(), { bigint: true }), owned = statSync(parent, { bigint: true });
const grandparent = statSync(dirname(parent), { bigint: true });
if (!owned.isDirectory() || !basename(parent).startsWith('AriadneRootSwitchNative-') || temp.ino === 0n
  || grandparent.dev !== temp.dev || grandparent.ino !== temp.ino) process.exit(1);
// This parent exercises actual Electron exit and the original Main/helper OS
// lease. It has no ApplicationController, Renderer, tool or notification owner;
// its Chromium profile stays separate from the original and restored data.
app.setPath('userData', join(parent, 'controllerProfile')); app.setPath('sessionData', join(parent, 'controllerProfile'));
void app.whenReady().then(async () => {
  const lease = await acquireDataRootOwnerLease(root!);
  const worker = await prepareDataRootSwitchWorker({ executable: executable!, entry: entry!, dataRoot: root!, operationId: operationId!, choice: 'replacement' });
  process.send?.({ ready: true, helperPid: worker.pid });
  process.once('message', async (input: unknown) => {
    if (input !== 0 && input !== 7) { await worker.cancel(); lease.dispose(); app.exit(1); return; }
    await worker.arm(); app.exit(input);
  });
}).catch(() => app.exit(1));

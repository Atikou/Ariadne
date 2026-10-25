import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Read only the retained, isolated acceptance directory before Main starts.
const [rootArgument, previousEvidence, outputPath] = process.argv.slice(2);
if (!rootArgument || !previousEvidence || !outputPath) throw new Error('Task reminder restart arguments missing.');
const root = resolve(rootArgument);
const ready = JSON.parse(await readFile(previousEvidence, 'utf8'));
const result = JSON.parse(await readFile(join(dirname(previousEvidence), 'decision-notification.json'), 'utf8'));
const reminders = result.observations?.taskReminders;
if (resolve(ready.root) !== root || !Number.isSafeInteger(ready.mainPid) || !result.passed
  || !reminders?.completedRunNativeShown || !reminders.failedRunNativeShown)
  throw new Error('Previous actual native completed/failed acceptance missing.');
const database = new DatabaseSync(join(root, 'notification-delivery.db'), { readOnly: true });
try {
  const preferences = database.prepare('SELECT state,enabled,enabled_since FROM notification_preferences ORDER BY state').all();
  const deliveries = database.prepare('SELECT * FROM notification_delivery ORDER BY run_id,workspace_id,session_id,version,state,source_status LIMIT 33').all();
  if (preferences.length !== 2 || preferences.some(row => row.enabled !== 1) || deliveries.length > 32
    || deliveries.some(row => row.shown_at === null)) throw new Error('Native fixture is not settled for a read-only restart.');
  for (const receipt of [reminders.displayReceipt, reminders.failureDisplayReceipt]) {
    if (!receipt || !deliveries.some(row => Object.entries(receipt).every(([key, value]) => row[key] === value)))
      throw new Error('Actual native shown receipt differs from the retained ledger.');
  }
  await writeFile(outputPath, JSON.stringify({ root, previousMainPid: ready.mainPid, workspaceId: ready.workspaceId,
    preferences, deliveries, completedAndFailedNativeShown: true }, null, 2));
} finally { database.close(); }

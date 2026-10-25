import { Notification, type BrowserWindow } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { taskNotificationReferenceSchema } from '@shared/task-notification';
import { taskCenterPageSchema } from '@ariadne/protocol/public';

/** A clean Main reopen on the same retained Source and delivery ledger.
 * Does not create tasks, change preferences, or synthesize native callbacks. */
export async function verifyTaskNotificationRestart(window: BrowserWindow, outputRoot: string): Promise<boolean> {
  const checkpoint = JSON.parse(await readFile(join(outputRoot, 'task-reminder-restart-checkpoint.json'), 'utf8')) as {
    root: string; previousMainPid: number; workspaceId: string; completedAndFailedNativeShown: boolean;
    preferences: Array<{ state: string; enabled: number; enabled_since: string }>;
    deliveries: Array<{ run_id: string; workspace_id: string; session_id: string; version: number;
      state: string; source_status: string; shown_at: string; retry_after: number }>;
  };
  if (checkpoint.root !== process.env.ARIADNE_SMOKE_USER_DATA || checkpoint.previousMainPid === process.pid
    || checkpoint.workspaceId !== process.env.ARIADNE_SMOKE_WORKSPACE_ID || !checkpoint.completedAndFailedNativeShown
    || !Notification.isSupported()) throw new Error('task_reminder_restart_source_invalid');
  window.hide();
  if (window.isVisible() || window.isFocused()) throw new Error('task_reminder_restart_not_background');
  const references = checkpoint.deliveries.map(row => taskNotificationReferenceSchema.parse({ runId: row.run_id,
    workspaceId: row.workspace_id, sessionId: row.session_id, version: row.version, state: row.state, sourceStatus: row.source_status }));
  if (!references.some(row => row.state === 'completed') || !references.some(row => row.state === 'failed'))
    throw new Error('task_reminder_restart_terminal_kinds_missing');
  const sourceRows = [];
  for (const reference of references) {
    const command = {
      kind: 'tasks.query', contractVersion: '1.0', cursor: null, limit: 1, refresh: true,
      filter: { reference: { source: 'run', sourceId: reference.runId }, workspaceId: reference.workspaceId,
        sessionId: reference.sessionId, includeArchived: false, sources: ['run'], states: [reference.state],
        updatedFrom: null, updatedThrough: null }
    };
    const deadline = Date.now() + 60_000;
    let page;
    do {
      const result = await window.webContents.executeJavaScript(`window.ariadne.runtime.request(${JSON.stringify(command)})`, true);
      if (!result.ok) throw new Error('task_reminder_restart_source_request_failed');
      command.refresh = false;
      page = taskCenterPageSchema.parse(result.value);
      if (!page.watermarks.some(mark => mark.status === 'building')) break;
      if (Date.now() >= deadline) throw new Error('task_reminder_restart_source_build_timeout');
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (true);
    const row = page.rows[0];
    if (!row || row.metadata.reference.sourceId !== reference.runId || row.metadata.version !== reference.version
      || row.metadata.workspaceId !== reference.workspaceId || row.metadata.sessionId !== reference.sessionId
      || row.metadata.state !== reference.state || row.metadata.sourceStatus !== reference.sourceStatus
      || page.watermarks.some(mark => mark.source !== 'productivity' && mark.status !== 'ready')) {
      await writeFile(join(outputRoot, 'task-reminder-restart-source-mismatch.json'), JSON.stringify({
        reference, current: row?.metadata ?? null, watermarks: page.watermarks
      }, null, 2));
      throw new Error('task_reminder_restart_core_source_changed');
    }
    sourceRows.push(reference);
  }
  // The production notification owner polls every 15 seconds, also on Source events.
  await new Promise(resolve => setTimeout(resolve, 35_000));
  if (window.isVisible() || window.isFocused()) throw new Error('task_reminder_restart_background_changed');
  const database = new DatabaseSync(join(checkpoint.root, 'notification-delivery.db'), { readOnly: true });
  try {
    const preferences = database.prepare('SELECT state,enabled,enabled_since FROM notification_preferences ORDER BY state').all();
    const deliveries = database.prepare('SELECT * FROM notification_delivery ORDER BY run_id,workspace_id,session_id,version,state,source_status LIMIT 33').all();
    if (JSON.stringify(preferences) !== JSON.stringify(checkpoint.preferences)
      || JSON.stringify(deliveries) !== JSON.stringify(checkpoint.deliveries)) throw new Error('task_reminder_restart_delivery_or_window_changed');
    await writeFile(join(outputRoot, 'task-notification-main-restart.json'), JSON.stringify({ passed: true,
      previousMainPid: checkpoint.previousMainPid, newMainPid: process.pid, actualMainProcessChanged: true,
      sameDataDirectory: true, originalCoreTerminalReferences: sourceRows, preferencesAndEnablementWindowsUnchanged: true,
      nativeShownReceiptsUnchanged: true, noAdditionalDeliveryAttempts: true, backgroundObservationMs: 35_000,
      scope: 'Actual clean Main reopen and original Core Source reads after native shown callbacks; no physical kill or Windows toast click.'
    }, null, 2));
    return true;
  } finally { database.close(); }
}

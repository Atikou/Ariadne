import { DECISION_NOTIFICATION_GROUP, decisionNotificationTag } from './decision-notification-activation';
import type { DecisionNotificationReference } from './decision-notification-source';

// Windows history survives the Electron Notification object and Main process.
// Remove only validated receipt tags in our group/AppID, never clear history.
export async function removeDecisionNotificationHistory(references: readonly DecisionNotificationReference[],
  execute: (encodedScript: string) => Promise<string | null>): Promise<boolean> {
  if (references.length === 0 || process.platform !== 'win32') return true;
  if (references.length > 64) throw new Error('notification_history_batch_exceeded');
  const tags = [...new Set(references.map(decisionNotificationTag))];
  const data = Buffer.from(JSON.stringify(tags), 'utf8').toString('base64');
  const script = `$ErrorActionPreference='Stop'
$tags=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')))
$history=[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]::History
foreach($tag in $tags) { $history.Remove([string]$tag,'${DECISION_NOTIFICATION_GROUP}','com.ariadne.desktop') }
[Console]::Write('ariadne-notification-history-removed')`;
  const result = await execute(Buffer.from(script, 'utf16le').toString('base64'));
  if (result === 'ariadne-notification-history-removed') return true;
  console.warn('Decision notification history cleanup is unavailable; display receipts are retained for retry.');
  return false;
}

import { createHash } from 'node:crypto';
import type { NotificationConstructorOptions } from 'electron';
import { taskNotificationReferenceSchema, type TaskNotificationReference } from '@shared/task-notification';
import type { ApprovalNotificationContent } from './approval-notification-service';

const PREFIX = 'ariadne-task:v1:';
export function parseTaskNotificationActivation(details: { type: string; arguments: string }): TaskNotificationReference | null {
  if (details.type !== 'click' || details.arguments.length > 2048 || !details.arguments.startsWith(PREFIX)) return null;
  try {
    const encoded = details.arguments.slice(PREFIX.length), decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    if (Buffer.from(decoded).toString('base64url') !== encoded) return null;
    return taskNotificationReferenceSchema.parse(JSON.parse(decoded));
  } catch { return null; }
}
export function windowsTaskNotificationOptions(content: ApprovalNotificationContent): NotificationConstructorOptions {
  const reference = taskNotificationReferenceSchema.parse(content.taskNavigation);
  const launch = PREFIX + Buffer.from(JSON.stringify(reference)).toString('base64url');
  const id = createHash('sha256').update(JSON.stringify(reference)).digest('base64url').slice(0, 16);
  return { title: content.title, body: content.body, groupId: 'ariadne.task', id,
    toastXml: `<toast launch="${xml(launch)}"><visual><binding template="ToastGeneric"><text>${xml(content.title)}</text><text>${xml(content.body)}</text></binding></visual></toast>` };
}
function xml(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '')
    .replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&apos;');
}

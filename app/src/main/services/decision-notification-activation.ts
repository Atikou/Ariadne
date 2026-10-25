import { createHash } from 'node:crypto';
import { z } from 'zod';
import { publicProjectionCanonicalIdSchema } from '@ariadne/protocol/public';
import type { NotificationConstructorOptions } from 'electron';
import type { ApprovalNotificationContent } from './approval-notification-service';
import type { DecisionNotificationReference } from './decision-notification-source';

const PREFIX = 'ariadne-decision:v1:';
export const DECISION_NOTIFICATION_GROUP = 'ariadne.decide';
const referenceSchema = z.object({ decisionId: publicProjectionCanonicalIdSchema,
  sessionId: publicProjectionCanonicalIdSchema, runId: publicProjectionCanonicalIdSchema,
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();

/** Windows launch data is an untrusted navigation reference, never an approval. */
export function parseDecisionNotificationActivation(details: { type: string; arguments: string }): DecisionNotificationReference | null {
  if (details.type !== 'click' || details.arguments.length > 2_048 || !details.arguments.startsWith(PREFIX)) return null;
  try {
    const encoded = details.arguments.slice(PREFIX.length);
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== encoded) return null;
    return referenceSchema.parse(JSON.parse(decoded));
  } catch { return null; }
}

export function windowsDecisionNotificationOptions(content: ApprovalNotificationContent): NotificationConstructorOptions {
  const { title, body, navigation } = content;
  if (!navigation) return { title, body };
  const reference = referenceSchema.parse(navigation);
  const launch = PREFIX + Buffer.from(JSON.stringify(reference), 'utf8').toString('base64url');
  return { title, body, groupId: DECISION_NOTIFICATION_GROUP,
    id: decisionNotificationTag(reference),
    toastXml: `<toast launch="${xml(launch)}"><visual><binding template="ToastGeneric"><text>${xml(title)}</text><text>${xml(body)}</text></binding></visual></toast>` };
}

export function decisionNotificationTag(reference: DecisionNotificationReference): string {
  return createHash('sha256').update(referenceSchema.parse(reference).decisionId).digest('base64url').slice(0, 16);
}

function xml(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '')
    .replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;').replace(/'/gu, '&apos;');
}

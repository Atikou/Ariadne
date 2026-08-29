export type ConversationRunHandoffDerivedIdKind =
  | 'run-request'
  | 'request-command'
  | 'request-inbox'
  | 'request-outbox'
  | 'link-command'
  | 'link-outbox'
  | 'start-failure-command'
  | 'start-failure-inbox'
  | 'start-failure-outbox'
  | 'result-command'
  | 'result-inbox'
  | 'result-outbox';

export type ConversationAuthorityDerivedIdKind =
  | 'session-created-event'
  | 'session-updated-event'
  | 'message-accepted-event'
  | 'agent-result-command'
  | 'agent-result-event'
  | 'agent-result-message'
  | 'agent-start-failure-command'
  | 'agent-start-failure-event'
  | 'agent-start-failure-message'
  | 'handoff-saga'
  | 'handoff-accept-command'
  | 'handoff-accept-outbox';

export async function deriveConversationAuthorityId(
  kind: ConversationAuthorityDerivedIdKind,
  sourceCommandId: string
): Promise<string> {
  if (![
    'session-created-event',
    'session-updated-event',
    'message-accepted-event',
    'agent-result-command',
    'agent-result-event',
    'agent-result-message',
    'agent-start-failure-command',
    'agent-start-failure-event',
    'agent-start-failure-message',
    'handoff-saga',
    'handoff-accept-command',
    'handoff-accept-outbox'
  ].includes(kind)) {
    throw new Error('conversation_authority_derived_id_kind_invalid');
  }
  return deriveId('authority', kind, sourceCommandId);
}

/**
 * Stable, reference-only identities for one outbox-driven handoff step.
 * Payload fields are deliberately excluded: the stable command identity stays
 * fixed while the command fingerprint rejects any payload drift.
 */
export async function deriveConversationRunHandoffStepId(
  kind: ConversationRunHandoffDerivedIdKind,
  sourceOutboxMessageId: string
): Promise<string> {
  if (![
    'run-request',
    'request-command',
    'request-inbox',
    'request-outbox',
    'link-command',
    'link-outbox',
    'start-failure-command',
    'start-failure-inbox',
    'start-failure-outbox',
    'result-command',
    'result-inbox',
    'result-outbox'
  ].includes(kind)) {
    throw new Error('conversation_handoff_derived_id_kind_invalid');
  }
  return deriveId('handoff', kind, sourceOutboxMessageId);
}

async function deriveId(
  namespace: 'authority' | 'handoff',
  kind: ConversationAuthorityDerivedIdKind | ConversationRunHandoffDerivedIdKind,
  sourceId: string
): Promise<string> {
  assertCanonicalId(sourceId);
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new Error('conversation_handoff_id_crypto_unavailable');
  }
  const canonical = JSON.stringify(namespace === 'handoff'
    ? ['ariadne.conversation-run-handoff-id', 1, kind, sourceId]
    : ['ariadne.conversation-authority-id', 1, kind, sourceId]);
  const digest = await subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical)
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return namespace === 'handoff'
    ? `conversation-${kind}-${hex}`
    : `conversation-authority-${kind}-${hex}`;
}

function assertCanonicalId(value: string): void {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 256
    || value.trim() !== value
  ) {
    throw new Error('conversation_handoff_source_outbox_id_invalid');
  }
}

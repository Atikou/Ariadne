import { AgentRunInvariantError } from './errors.js';
import {
  assertCanonicalPublicId,
  assertPositiveInteger,
  assertTimestamp
} from './values.js';

export type AgentInboxDelivery = 'next_turn' | 'next_step';

interface AgentInboxInputBase {
  readonly inputId: string;
  readonly messageId: string;
  readonly version: number;
  readonly delivery: AgentInboxDelivery;
  readonly content: string;
  readonly contentDigest: string;
  readonly queuedAt: string;
  readonly updatedAt: string;
}

export type AgentInboxInput =
  | (AgentInboxInputBase & { readonly state: 'queued' })
  | (AgentInboxInputBase & {
      readonly state: 'claimed';
      readonly claimedAt: string;
      readonly claimedTurnId: string;
    });

export function assertValidAgentInboxInput(input: AgentInboxInput): void {
  const expectedKeys = input.state === 'claimed'
    ? [
        'inputId', 'messageId', 'version', 'delivery', 'content',
        'contentDigest', 'queuedAt', 'updatedAt', 'state', 'claimedAt',
        'claimedTurnId'
      ]
    : [
        'inputId', 'messageId', 'version', 'delivery', 'content',
        'contentDigest', 'queuedAt', 'updatedAt', 'state'
      ];
  const keys = Object.keys(input).sort();
  const expected = [...expectedKeys].sort();
  if (
    keys.length !== expected.length
    || keys.some((key, index) => key !== expected[index])
  ) throw invalid('Agent inbox input fields are invalid.');
  assertCanonicalPublicId(input.inputId, 'inbox.inputId');
  assertCanonicalPublicId(input.messageId, 'inbox.messageId');
  assertPositiveInteger(input.version, 'inbox.version');
  if (input.delivery !== 'next_turn' && input.delivery !== 'next_step') {
    throw invalid('Agent inbox delivery is invalid.');
  }
  if (
    typeof input.content !== 'string'
    || input.content.length === 0
    || input.content.length > 100_000
    || input.content.trim().length === 0
  ) throw invalid('Agent inbox content must be bounded and non-empty.');
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.contentDigest)) {
    throw invalid('Agent inbox content digest is invalid.');
  }
  assertTimestamp(input.queuedAt, 'inbox.queuedAt');
  assertTimestamp(input.updatedAt, 'inbox.updatedAt');
  if (
    Date.parse(input.updatedAt) < Date.parse(input.queuedAt)
    || (input.state !== 'queued' && input.state !== 'claimed')
  ) throw invalid('Agent inbox timestamps or state are invalid.');
  if (input.state === 'claimed') {
    assertTimestamp(input.claimedAt, 'inbox.claimedAt');
    assertCanonicalPublicId(input.claimedTurnId, 'inbox.claimedTurnId');
    if (
      input.updatedAt !== input.claimedAt
      || Date.parse(input.claimedAt) < Date.parse(input.queuedAt)
    ) throw invalid('Claimed Agent inbox timestamps are invalid.');
  }
}

function invalid(message: string): AgentRunInvariantError {
  return new AgentRunInvariantError(message);
}

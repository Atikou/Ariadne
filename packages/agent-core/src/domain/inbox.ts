import { AgentRunInvariantError } from './errors.js';
import {
  assertCanonicalPublicId,
  assertPositiveInteger,
  assertTimestamp
} from './values.js';

export type AgentInboxDelivery = 'next_turn' | 'next_step';

/** Explicit non-user sources share the durable queue without impersonating a user message. */
export interface AgentLiveWorkInboxSource {
  readonly kind: 'live_work';
  readonly jobId: string;
  readonly workKind: string;
  readonly status: 'completed' | 'killed' | 'failed' | 'interrupted';
}

export interface AgentUserQuestionAnswerInboxSource {
  readonly kind: 'user_question_answer';
  readonly decisionId: string;
  readonly questionDigest: string;
}

export type AgentInboxInputSource =
  | AgentLiveWorkInboxSource
  | AgentUserQuestionAnswerInboxSource;

interface AgentInboxInputBase {
  readonly inputId: string;
  readonly messageId: string;
  readonly version: number;
  readonly delivery: AgentInboxDelivery;
  readonly content: string;
  readonly contentDigest: string;
  readonly source?: AgentInboxInputSource;
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
  if (input.source !== undefined) expectedKeys.push('source');
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
  if (input.source !== undefined) assertValidSource(input.source);
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

function assertValidSource(source: AgentInboxInputSource): void {
  if (source.kind === 'user_question_answer') {
    const keys = Object.keys(source).sort();
    const expected = ['decisionId', 'kind', 'questionDigest'];
    if (
      keys.length !== expected.length
      || keys.some((key, index) => key !== expected[index])
    ) throw invalid('Agent user-question answer source fields are invalid.');
    assertCanonicalPublicId(source.decisionId, 'inbox.source.decisionId');
    if (!/^sha256:[a-f0-9]{64}$/u.test(source.questionDigest)) {
      throw invalid('Agent user-question answer source digest is invalid.');
    }
    return;
  }
  const keys = Object.keys(source).sort();
  const expected = ['jobId', 'kind', 'status', 'workKind'];
  if (
    keys.length !== expected.length
    || keys.some((key, index) => key !== expected[index])
    || source.kind !== 'live_work'
    || typeof source.jobId !== 'string'
    || source.jobId.length === 0
    || source.jobId.length > 256
    || source.jobId !== source.jobId.trim()
    || typeof source.workKind !== 'string'
    || source.workKind.length === 0
    || source.workKind.length > 64
    || source.workKind !== source.workKind.trim()
    || !['completed', 'killed', 'failed', 'interrupted'].includes(source.status)
  ) throw invalid('Agent inbox source is invalid.');
}

function invalid(message: string): AgentRunInvariantError {
  return new AgentRunInvariantError(message);
}

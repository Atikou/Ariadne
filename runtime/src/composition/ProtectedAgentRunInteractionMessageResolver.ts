import {
  AgentRunInvariantError,
  assertValidAgentRun,
  deriveStableAgentId,
  type AgentDirectivePayloadLookup,
  type AgentDirectivePayloadReader,
  type AgentInferenceAttempt,
  type AgentRun
} from '@ariadne/agent-core';

import type {
  AgentRunInteractionProjectionMessage,
  AgentRunInteractionProjectionResolver
} from '../projection/AgentRunProjectionPorts.js';

const MAX_INTERACTION_CONTENT_LENGTH = 1_048_576;

/**
 * Reconstructs the durable in-Run transcript from continuation causes.
 * Queued inputs stay in the inbox; only atomically claimed inputs become
 * transcript messages. Assistant responses appear only once a later Turn has
 * durably named their exact source Attempt.
 */
export class ProtectedAgentRunInteractionMessageResolver
implements AgentRunInteractionProjectionResolver {
  public constructor(private readonly payloads: AgentDirectivePayloadReader) {}

  public async resolveInteractionMessages(
    run: AgentRun
  ): Promise<readonly AgentRunInteractionProjectionMessage[]> {
    assertValidAgentRun(run);
    const messages: AgentRunInteractionProjectionMessage[] = [];

    for (const turn of run.turns.slice(1)) {
      const cause = turn.intention.cause;
      if (cause.kind !== 'inbox_inputs' && cause.kind !== 'effect_results') continue;

      if (cause.kind === 'inbox_inputs') {
        const sourceAttempt = requireSourceAttempt(
          run,
          cause.sourceTurnId,
          cause.sourceAttemptId,
          cause.sourceDirectiveDigest
        );
        messages.push({
          messageId: await deriveStableAgentId(
            'agent-interaction-assistant',
            run.runId,
            sourceAttempt.attemptId,
            sourceAttempt.state.directiveDigest
          ),
          turnId: turn.turnId,
          role: 'assistant',
          content: await resolveAttemptContent(this.payloads, run, sourceAttempt),
          occurredAt: sourceAttempt.state.finishedAt
        });
      }

      const inputIds = cause.kind === 'inbox_inputs'
        ? cause.inputIds
        : cause.inboxInputIds ?? [];
      for (const inputId of inputIds) {
        const input = run.inbox.find((candidate) => candidate.inputId === inputId);
        if (
          input === undefined
          || input.state !== 'claimed'
          || input.claimedTurnId !== turn.turnId
        ) {
          throw new AgentRunInvariantError(
            'An interaction message must bind an exact claimed inbox input.'
          );
        }
        messages.push({
          messageId: input.messageId,
          turnId: turn.turnId,
          role: 'user',
          content: input.content,
          occurredAt: input.claimedAt
        });
      }
    }
    return messages;
  }
}

function requireSourceAttempt(
  run: AgentRun,
  turnId: string,
  attemptId: string,
  directiveDigest: string
): AgentInferenceAttempt & {
  readonly state: Extract<AgentInferenceAttempt['state'], { readonly status: 'succeeded' }>;
} {
  const turn = run.turns.find((candidate) => candidate.turnId === turnId);
  const attempt = turn?.attempts.find((candidate) => candidate.attemptId === attemptId);
  if (
    attempt === undefined
    || attempt.state.status !== 'succeeded'
    || attempt.state.directiveDigest !== directiveDigest
    || (
      attempt.state.directive.kind !== 'respond'
      && attempt.state.directive.kind !== 'complete'
    )
  ) {
    throw new AgentRunInvariantError(
      'Inbox continuation source must be one exact succeeded response Attempt.'
    );
  }
  return attempt as AgentInferenceAttempt & {
    readonly state: Extract<AgentInferenceAttempt['state'], { readonly status: 'succeeded' }>;
  };
}

async function resolveAttemptContent(
  payloads: AgentDirectivePayloadReader,
  run: AgentRun,
  attempt: AgentInferenceAttempt & {
    readonly state: Extract<AgentInferenceAttempt['state'], { readonly status: 'succeeded' }>;
  }
): Promise<string> {
  const directive = attempt.state.directive;
  let reference: AgentDirectivePayloadLookup | null = null;
  if (directive.kind === 'respond') {
    reference = {
      runId: run.runId,
      artifactId: directive.contentRef,
      kind: 'response_content',
      directiveDigest: attempt.state.directiveDigest,
      contentDigest: directive.contentDigest
    };
  } else if (
    directive.kind === 'complete'
    && directive.outputRef !== undefined
    && directive.outputDigest !== undefined
  ) {
    reference = {
      runId: run.runId,
      artifactId: directive.outputRef,
      kind: 'completion_output',
      directiveDigest: attempt.state.directiveDigest,
      contentDigest: directive.outputDigest
    };
  }
  if (reference === null) return 'Agent completed without a textual response.';
  const content = await payloads.loadDirectivePayload(reference);
  if (
    typeof content !== 'string'
    || content.length === 0
    || content.length > MAX_INTERACTION_CONTENT_LENGTH
  ) {
    throw new AgentRunInvariantError(
      'Protected Agent interaction content must be a bounded non-empty string.'
    );
  }
  return content;
}

import {
  AgentRunInvariantError,
  assertValidAgentRun,
  type AgentDirectivePayloadLookup,
  type AgentDirectivePayloadReader,
  type AgentInferenceAttempt,
  type AgentRun
} from '@ariadne/agent-core';

const COMPLETED_WITHOUT_TEXT = 'Agent completed without a textual response.';
const CANCELLED_MESSAGE = 'The Agent run was cancelled.';
const MAX_ASSISTANT_CONTENT_LENGTH = 1_048_576;

export interface AgentTerminalAssistantContentResolver {
  resolveTerminalAssistantContent(run: AgentRun): Promise<string>;
}

/**
 * Resolves only the protected body referenced by the exact terminal inference
 * attempt. Failure/cancellation diagnostics remain private and become bounded
 * public-safe status text rather than leaking internal error material.
 */
export class ProtectedAgentTerminalAssistantContentResolver
implements AgentTerminalAssistantContentResolver {
  public constructor(private readonly payloads: AgentDirectivePayloadReader) {}

  public async resolveTerminalAssistantContent(run: AgentRun): Promise<string> {
    assertValidAgentRun(run);
    if (run.state.status === 'failed') {
      return `Agent run failed (${run.state.errorCode}).`;
    }
    if (run.state.status === 'cancelled') return CANCELLED_MESSAGE;
    if (run.state.status !== 'completed') {
      throw new AgentRunInvariantError(
        'Assistant result content can be resolved only for a terminal Agent Run.'
      );
    }

    const attempt = terminalContentAttempt(run);
    if (attempt === null) return COMPLETED_WITHOUT_TEXT;
    const state = attempt.state;
    if (state.status !== 'succeeded') {
      throw new AgentRunInvariantError('Terminal content attempt is not succeeded.');
    }
    const directive = state.directive;
    let reference: AgentDirectivePayloadLookup | null = null;
    if (directive.kind === 'respond') {
      reference = {
        runId: run.runId,
        artifactId: directive.contentRef,
        kind: 'response_content',
        directiveDigest: state.directiveDigest,
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
        directiveDigest: state.directiveDigest,
        contentDigest: directive.outputDigest
      };
    }
    if (reference === null) return COMPLETED_WITHOUT_TEXT;

    const payload = await this.payloads.loadDirectivePayload(reference);
    if (
      typeof payload !== 'string'
      || payload.length === 0
      || payload.length > MAX_ASSISTANT_CONTENT_LENGTH
    ) {
      throw new AgentRunInvariantError(
        'Protected terminal Agent content must be a bounded non-empty string.'
      );
    }
    return payload;
  }
}

function terminalContentAttempt(run: AgentRun): AgentInferenceAttempt | null {
  if (run.state.status !== 'completed') return null;
  const candidates: AgentInferenceAttempt[] = [];
  for (const turn of run.turns) {
    for (const attempt of turn.attempts) {
      if (
        attempt.state.status === 'succeeded'
        && attempt.state.finishedAt === run.state.completedAt
        && (
          attempt.state.directive.kind === 'respond'
          || attempt.state.directive.kind === 'complete'
        )
      ) {
        candidates.push(attempt);
      }
    }
  }
  if (candidates.length > 1) {
    throw new AgentRunInvariantError(
      'A completed Agent Run has multiple terminal content attempts.'
    );
  }
  return candidates[0] ?? null;
}

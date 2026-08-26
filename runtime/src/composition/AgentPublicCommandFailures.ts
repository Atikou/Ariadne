import { AgentCoreError } from '@ariadne/agent-core';

import type { RuntimeApplicationCommandResult } from '../ingress/RuntimeApplication.js';
import type { RuntimeCommandEnvelope } from '../ingress/RuntimeIngress.js';

export function publicRunMutationFailure(
  envelope: RuntimeCommandEnvelope,
  error: unknown
): RuntimeApplicationCommandResult | null {
  if (!(error instanceof AgentCoreError)) return null;
  if (error.code === 'AGENT_RUN_VERSION_CONFLICT') {
    return completedPublicError(
      envelope,
      'agent_run_version_conflict',
      'The Agent Run changed before this command was applied.',
      false
    );
  }
  if (error.code === 'AGENT_RUN_NOT_FOUND') {
    return completedPublicError(
      envelope,
      'agent_run_not_found',
      'The authoritative Agent Run does not exist.',
      false
    );
  }
  if (error.code === 'AGENT_RUN_TRANSITION') {
    return completedPublicError(
      envelope,
      'agent_run_action_invalid',
      'The Agent Run cannot accept this action in its current state.',
      false
    );
  }
  return null;
}

export function completedPublicError(
  envelope: RuntimeCommandEnvelope,
  code: string,
  message: string,
  retryable: boolean
): RuntimeApplicationCommandResult {
  return {
    outcome: {
      ok: false,
      error: {
        code,
        message,
        retryable,
        correlationId: envelope.correlationId
      }
    },
    settlement: 'completed'
  };
}

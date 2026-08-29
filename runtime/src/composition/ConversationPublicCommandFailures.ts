import {
  ConversationAuthorityError
} from '../conversation/ConversationAuthority.js';
import {
  ConversationRunHandoffError
} from '../conversation/ConversationRunHandoffSaga.js';
import type {
  RuntimeApplicationCommandResult
} from '../ingress/RuntimeApplication.js';
import type { RuntimeCommandEnvelope } from '../ingress/RuntimeIngress.js';
import { completedPublicError } from './AgentPublicCommandFailures.js';

/** Maps Conversation authority failures onto the stable public command contract. */
export function publicConversationFailure(
  envelope: RuntimeCommandEnvelope,
  error: unknown
): RuntimeApplicationCommandResult | null {
  if (error instanceof ConversationAuthorityError) {
    switch (error.code) {
      case 'CONVERSATION_SESSION_ALREADY_EXISTS':
        return completedPublicError(
          envelope,
          'conversation_session_exists',
          'The Conversation session already exists.',
          false
        );
      case 'CONVERSATION_SESSION_NOT_FOUND':
        return completedPublicError(
          envelope,
          'conversation_session_not_found',
          'The Conversation session does not exist.',
          false
        );
      case 'CONVERSATION_SESSION_VERSION_CONFLICT':
        return completedPublicError(
          envelope,
          'conversation_version_conflict',
          'The Conversation changed before this command was applied.',
          false
        );
      case 'CONVERSATION_SESSION_ARCHIVED':
        return completedPublicError(
          envelope,
          'conversation_session_archived',
          'The Conversation session is archived and cannot accept new messages.',
          false
        );
      case 'CONVERSATION_SESSION_MUTATION_UNCHANGED':
        return completedPublicError(
          envelope,
          'conversation_session_unchanged',
          'The Conversation session already has the requested state.',
          false
        );
      case 'CONVERSATION_WORKSPACE_MISMATCH':
        return completedPublicError(
          envelope,
          'conversation_workspace_mismatch',
          'The Conversation does not belong to that Workspace.',
          false
        );
      case 'CONVERSATION_MESSAGE_ALREADY_EXISTS':
      case 'CONVERSATION_COMMAND_CONFLICT':
        return completedPublicError(
          envelope,
          'conversation_command_conflict',
          'The Conversation command conflicts with an existing immutable fact.',
          false
        );
      case 'CONVERSATION_INVARIANT':
      case 'CONVERSATION_STORAGE_CORRUPTION':
        return null;
    }
  }
  if (error instanceof ConversationRunHandoffError) {
    switch (error.code) {
      case 'HANDOFF_ALREADY_EXISTS':
      case 'HANDOFF_NOT_FOUND':
      case 'HANDOFF_VERSION_CONFLICT':
      case 'HANDOFF_COMMAND_CONFLICT':
      case 'HANDOFF_INVALID_TRANSITION':
        return completedPublicError(
          envelope,
          'conversation_handoff_conflict',
          'The Conversation handoff conflicts with an existing immutable fact.',
          false
        );
      case 'HANDOFF_INVARIANT':
        return null;
    }
  }
  return null;
}

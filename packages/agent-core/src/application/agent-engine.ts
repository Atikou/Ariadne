import type { AgentRun } from '../domain/agent-run.js';
import type { AgentDirective } from '../domain/directive.js';
import type { AgentAvailableTool } from '../domain/tool.js';
import type { AgentJsonValue } from '../domain/json-value.js';
import type {
  AgentInferenceResponseEnvelopeV1,
  AgentInferenceUsageAnchorV1
} from '../domain/turn.js';

export interface AgentImageAttachmentReference {
  readonly attachmentId: string;
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly name?: string;
  readonly originalDimensions?: {
    readonly width: number;
    readonly height: number;
  };
}

export type AgentTurnInputMessage =
  | {
      readonly kind: 'text';
      readonly role: 'system' | 'user' | 'assistant';
      readonly content: string;
    }
  | {
      readonly kind: 'effect_result';
      readonly effectId: string;
      readonly toolCallId: string;
      readonly status: 'succeeded' | 'failed' | 'cancelled';
      readonly result: AgentJsonValue;
    }
  | {
      readonly kind: 'image';
      readonly role: 'user';
      readonly owner: {
        readonly sessionId: string;
        readonly workspaceId: string;
        readonly messageId: string;
        readonly messageVersion: number;
      };
      readonly attachment: AgentImageAttachmentReference;
    };

export interface AgentTurnInput {
  readonly run: AgentRun;
  readonly messages: AgentTurnInputModelData['messages'];
  readonly availableTools: AgentTurnInputModelData['availableTools'];
}

export interface AgentTurnInputModelData {
  readonly messages: readonly AgentTurnInputMessage[];
  readonly availableTools: readonly AgentAvailableTool[];
}

/**
 * A fully prepared, process-local Provider decision. Preparation is allowed to
 * read immutable contracts and derive a bounded model-context projection, but
 * it must not perform Provider I/O. Core persists `modelContext` with the
 * inference-start checkpoint before invoking `decide`.
 */
export interface PreparedAgentDecision {
  readonly modelContext: AgentJsonValue;
  decide(signal: AbortSignal): Promise<AgentDirective>;
  /** Available only after a successful `decide`; detached and validated at commit. */
  readonly readUsageAnchor?: () => AgentInferenceUsageAnchorV1 | null;
  /** Sanitized exact-response evidence available only after successful `decide`. */
  readonly readResponseEnvelope?: () => AgentInferenceResponseEnvelopeV1 | null;
  /** Non-authoritative presentation stream settled only after Agent Control commits. */
  readonly streamLifecycle?: {
    settle(status: 'committed' | 'interrupted'): Promise<void>;
  };
}

/**
 * A pure decision boundary. Implementations may call a model, but they never
 * execute tools, write state, emit UI events, or know about the host process.
 */
export interface AgentEngine {
  prepare(
    input: AgentTurnInput,
    signal: AbortSignal
  ): Promise<PreparedAgentDecision>;
}

import type { AgentRunBinding } from '@ariadne/agent-core';

export interface ExactAgentModelInferenceMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface DispatchExactAgentModelInferenceRequest {
  readonly binding: AgentRunBinding['model'];
  readonly messages: readonly ExactAgentModelInferenceMessage[];
  readonly signal: AbortSignal;
}

export type ExactAgentModelInferenceResult =
  | {
      readonly status: 'completed';
      readonly content: string;
      /** Non-zero (or invalid negative evidence) is rejected by AgentEngine. */
      readonly nativeToolCallCount: number;
    }
  | {
      readonly status: 'binding_unavailable';
    };

/**
 * Executes one text-only model inference against an exact immutable binding.
 * Implementations may perform transport security, but never route, fall back,
 * execute Tools, write Agent state, or emit domain events.
 */
export interface ExactAgentModelInferenceGateway {
  inferExact(
    request: DispatchExactAgentModelInferenceRequest
  ): Promise<ExactAgentModelInferenceResult>;
}

/** Exact inference plus the synchronous admission/recovery availability gate. */
export interface ExactAgentModelInferenceRuntime
extends ExactAgentModelInferenceGateway {
  hasExactBinding(binding: AgentRunBinding['model']): boolean;
  resolveBinding(
    settingsRevision: number,
    preference?: AgentModelSelectionPreference
  ): AgentRunBinding['model'] | null;
}

export interface AgentModelSelectionPreference {
  readonly modelId?: string;
  readonly routingStrategy?:
    | 'local-first'
    | 'cloud-first'
    | 'privacy-first'
    | 'quality-first';
}

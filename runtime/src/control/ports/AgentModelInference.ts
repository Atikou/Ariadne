import type { AgentRunBinding, AgentToolJsonValue } from '@ariadne/agent-core';

export type ExactAgentModelInferenceRequestContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image';
      readonly attachmentId: string;
      readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
      readonly dataBase64: string;
      readonly bytes: number;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly type: 'tool_call';
      /** Sanitized request-local identity shared with the matching result block. */
      readonly toolCallId: string;
      readonly providerToolName: string;
      readonly input: AgentToolJsonValue;
    }
  | {
      readonly type: 'tool_result';
      /** Durable Ariadne identity used only for protected spill/retrieval projection. */
      readonly effectId: string;
      readonly toolCallId: string;
      readonly status: 'succeeded' | 'failed' | 'cancelled';
      readonly output: AgentToolJsonValue;
    };

/** Provider-neutral immutable message used by history, compaction, and every adapter. */
export interface ExactAgentModelInferenceMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: readonly ExactAgentModelInferenceRequestContentBlock[];
}

export interface ExactAgentModelInferenceObservedChunk {
  readonly sequence: number;
  readonly channel: 'token' | 'reasoning';
  readonly text: string;
}

/** One frozen, data-only native Tool contract for the exact Provider request. */
export interface ExactAgentModelInferenceToolContract {
  readonly providerToolName: string;
  readonly description: string;
  readonly inputSchema: AgentToolJsonValue;
}

export type ExactAgentModelInferenceContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }
  | {
      readonly type: 'tool_call';
      /** Sanitized stable identity; raw Provider call identities never cross this port. */
      readonly toolCallId: string;
      readonly providerToolName: string;
      readonly input: AgentToolJsonValue;
    };

export type ExactAgentModelInferenceFinishReason =
  | 'stop'
  | 'tool_calls'
  | 'length'
  | 'content_filter'
  | 'other';

/** Sanitized evidence required to replay the exact response boundary. */
export interface ExactAgentModelInferenceReplayEnvelopeV1 {
  readonly envelopeVersion: 1;
  readonly adapter: 'openai-compatible' | 'anthropic-messages' | 'embedded-local';
  readonly finishReason: ExactAgentModelInferenceFinishReason;
  readonly requestEnvelopeDigest: string;
  readonly contentBlocksDigest: string;
  readonly providerResponseIdDigest?: string;
}

/** Attempt-bound sink supplied by composition; the transport never invents identity. */
export interface ExactAgentModelInferenceChunkObserver {
  observe(chunk: ExactAgentModelInferenceObservedChunk): void | Promise<void>;
}

export interface DispatchExactAgentModelInferenceRequest {
  readonly binding: AgentRunBinding['model'];
  readonly messages: readonly ExactAgentModelInferenceMessage[];
  readonly tools: readonly ExactAgentModelInferenceToolContract[];
  readonly signal: AbortSignal;
  readonly chunkObserver?: ExactAgentModelInferenceChunkObserver;
}

export interface ExactAgentModelContextCapacity {
  /** Exact configured capacity for this provider/model/settings tuple. */
  readonly contextWindowTokens: number;
  /** Output space reserved before any input is admitted. */
  readonly maxOutputTokens: number;
}

export type ExactAgentModelInferenceResult =
  | {
      readonly status: 'completed';
      readonly contentBlocks: readonly ExactAgentModelInferenceContentBlock[];
      readonly replay: ExactAgentModelInferenceReplayEnvelopeV1;
      /**
       * Exact Provider usage for the exact serialized request envelope, when supplied.
       * Input counts are disjoint: context input is input + cache read + cache write.
       */
      readonly usage?: {
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly cacheReadInputTokens?: number;
        readonly cacheWriteInputTokens?: number;
      };
    }
  | {
      readonly status: 'binding_unavailable';
    }
  | {
      /** Canonical, sanitized proof that the exact Provider rejected context size. */
      readonly status: 'context_overflow';
    };

/**
 * Executes one Provider-neutral content inference against an exact immutable binding.
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

  describeContextCapacity(
    binding: AgentRunBinding['model']
  ): ExactAgentModelContextCapacity | null;
}

export interface AgentModelSelectionPreference {
  readonly modelId?: string;
  readonly requiresVision?: boolean;
  readonly routingStrategy?:
    | 'local-first'
    | 'cloud-first'
    | 'privacy-first'
    | 'quality-first';
}

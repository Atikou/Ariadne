import type { AgentRun } from '../domain/agent-run.js';
import type { AgentDirective } from '../domain/directive.js';
import type { AgentAvailableTool } from '../domain/tool.js';
import type { AgentJsonValue } from '../domain/json-value.js';

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
 * A pure decision boundary. Implementations may call a model, but they never
 * execute tools, write state, emit UI events, or know about the host process.
 */
export interface AgentEngine {
  decide(input: AgentTurnInput, signal: AbortSignal): Promise<AgentDirective>;
}

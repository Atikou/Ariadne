import { countTokens as countCl100kTokens } from 'gpt-tokenizer/encoding/cl100k_base';
import { countTokens as countO200kTokens } from 'gpt-tokenizer/encoding/o200k_base';

import type {
  ExactAgentModelInferenceMessage,
  ExactAgentModelInferenceToolContract,
  ExactAgentModelTokenCount
} from '../../control/ports/AgentModelInference.js';
import { estimateMessagesTokens } from './V3LongContextLifecycle.js';

/**
 * A route-local tokenizer must be bound to the exact Provider/model revision.
 * OpenAI BPE encodings are available locally; non-OpenAI wire templates stay
 * explicitly conservative until a deployment supplies its model tokenizer.
 */
export function countRemoteRequestTokens(input: {
  readonly providerId: string;
  readonly modelId: string;
  readonly protocol: 'openai-compatible' | 'anthropic-messages';
  readonly messages: readonly ExactAgentModelInferenceMessage[];
  readonly tools: readonly ExactAgentModelInferenceToolContract[];
}): ExactAgentModelTokenCount {
  const serialized = JSON.stringify({ messages: input.messages, tools: input.tools });
  if (input.providerId === 'openai') {
    const o200k = usesO200k(input.modelId);
    return {
      tokens: Math.max(1, (o200k ? countO200kTokens : countCl100kTokens)(serialized)),
      exact: false,
      tokenizer: `openai:${input.modelId}:${o200k ? 'o200k_base' : 'cl100k_base'}:local-wire-conservative`
    };
  }
  return {
    tokens: estimateMessagesTokens([
      ...input.messages,
      ...(input.tools.length === 0
        ? []
        : [{
            role: 'system' as const,
            content: [{ type: 'text' as const, text: JSON.stringify(input.tools) }]
          }])
    ]),
    exact: false,
    tokenizer: `${input.providerId}:${input.modelId}:${input.protocol}:local-conservative`
  };
}

function usesO200k(modelId: string): boolean {
  return /^(?:gpt-4o|gpt-4\.1|gpt-5|o[134])(?:-|$)/iu.test(modelId);
}

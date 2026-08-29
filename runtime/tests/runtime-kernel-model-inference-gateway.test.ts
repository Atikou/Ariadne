import { describe, expect, it, vi } from 'vitest';

import {
  LOCAL_AGENT_MODEL_PROVIDER_ID,
  RuntimeKernelModelInferenceGateway
} from '../src/application/RuntimeKernelModelInferenceGateway.js';
import type {
  DispatchExactAgentModelInferenceRequest,
  ExactAgentModelInferenceRuntime
} from '../src/control/ports/AgentModelInference.js';
import type { LocalModelService } from '../src/model/local/LocalModelService.js';
import type { ModelClient } from '../src/model/types.js';

describe('RuntimeKernelModelInferenceGateway', () => {
  it('projects typed Tool history to the embedded model native Chat boundary', async () => {
    const chat = vi.fn<ModelClient['chat']>(async () => ({
      content: 'continued locally',
      toolCalls: [],
      clientName: 'local-exact',
      modelName: 'local-exact',
      location: 'local',
      latencyMs: 1,
      usage: { inputTokens: 30, outputTokens: 4 }
    }));
    const client = {
      name: 'local-exact',
      contextWindowTokens: 32_768,
      chat
    };
    const localModels = {
      clients: () => [client]
    } as unknown as LocalModelService;
    const remote: ExactAgentModelInferenceRuntime = {
      inferExact: async () => ({ status: 'binding_unavailable' }),
      hasExactBinding: () => false,
      resolveBinding: () => null,
      describeContextCapacity: () => null
    };
    const gateway = new RuntimeKernelModelInferenceGateway(
      remote,
      localModels,
      [],
      'local-first'
    );
    const request: DispatchExactAgentModelInferenceRequest = {
      binding: {
        providerId: LOCAL_AGENT_MODEL_PROVIDER_ID,
        modelId: 'local-exact',
        settingsRevision: 3
      },
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'read it' }] },
        {
          role: 'assistant',
          content: [{
            type: 'tool_call',
            toolCallId: 'history_local_1',
            providerToolName: 'ariadne_local_tool',
            input: { input: { path: 'README.md' }, scope: [] }
          }]
        },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            effectId: 'effect-private',
            toolCallId: 'history_local_1',
            status: 'succeeded',
            output: { content: 'ok' }
          }]
        }
      ],
      tools: [{
        providerToolName: 'ariadne_local_tool',
        description: 'Local Tool.',
        inputSchema: { type: 'object' }
      }],
      signal: new AbortController().signal
    };

    await expect(gateway.inferExact(request)).resolves.toMatchObject({
      status: 'completed',
      contentBlocks: [{ type: 'text', text: 'continued locally' }],
      replay: { adapter: 'embedded-local', finishReason: 'stop' },
      usage: { inputTokens: 30, outputTokens: 4 }
    });
    expect(chat).toHaveBeenCalledTimes(1);
    const sent = chat.mock.calls[0]![0];
    expect(sent.messages).toEqual([
      { role: 'user', content: 'read it' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: 'history_local_1',
          name: 'ariadne_local_tool',
          arguments: { input: { path: 'README.md' }, scope: [] }
        }]
      },
      {
        role: 'tool',
        toolCallId: 'history_local_1',
        content: JSON.stringify({ status: 'succeeded', output: { content: 'ok' } })
      }
    ]);
    expect(JSON.stringify(sent.messages)).not.toContain('effect-private');
  });
});

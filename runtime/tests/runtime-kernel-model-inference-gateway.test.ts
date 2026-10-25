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
  it('checks only the chosen remote connection before admission, falling back on failure but not cancellation', async () => {
    const remote = { describeExecutionQualification: () => ({ supportsTextResponse: true, supportsAgent: true, supportsPlan: true, supportsVision: false }) } as unknown as ExactAgentModelInferenceRuntime;
    const locals = { clients: () => [{ name: 'local', toolCallCapability: 'native' }] } as unknown as LocalModelService;
    const check = vi.fn(async () => false);
    const gateway = new RuntimeKernelModelInferenceGateway(remote, locals,
      [{ providerId: 'fixture', model: 'remote', enabled: true }] as never,
      { modelId: 'remote', localFallbackModelId: 'local' }, undefined, () => true,
      new Set(), () => {}, check);
    const signal = new AbortController().signal;
    expect(await gateway.prepareBinding(3, {}, signal)).toEqual({ providerId: 'ariadne.local', modelId: 'local', settingsRevision: 3 });
    expect(check).toHaveBeenCalledExactlyOnceWith('remote', signal);
    check.mockResolvedValue(true);
    expect(await gateway.prepareBinding(3, {}, signal)).toMatchObject({ modelId: 'remote' });
    check.mockClear();
    expect(await gateway.prepareBinding(3, { localFallbackModelId: null }, signal)).toMatchObject({ modelId: 'remote' });
    expect(check).not.toHaveBeenCalled();
    const controller = new AbortController();
    check.mockImplementation(async () => { controller.abort(); return false; });
    await expect(gateway.prepareBinding(3, {}, controller.signal)).rejects.toThrow();
  });
  it('uses exactly the selected model and only its explicit local fallback when remote is unavailable', () => {
    let available = true;
    const remote = { describeExecutionQualification: () => ({ supportsTextResponse: true, supportsAgent: true, supportsPlan: false, supportsVision: false }) } as unknown as ExactAgentModelInferenceRuntime;
    const locals = { clients: () => [{ name: 'local', toolCallCapability: 'native' }, { name: 'disabled', toolCallCapability: 'native' }] } as unknown as LocalModelService;
    const gateway = new RuntimeKernelModelInferenceGateway(remote, locals,
      [{ providerId: 'fixture', model: 'remote', enabled: true }] as never,
      { modelId: '', localFallbackModelId: '' }, undefined, () => available, new Set(['disabled']));
    expect(gateway.resolveBinding(1)).toBeNull();
    expect(gateway.resolveBinding(1, { modelId: 'remote' })?.modelId).toBe('remote');
    expect(gateway.resolveBinding(1, { modelId: 'local' })?.modelId).toBe('local');
    expect(() => gateway.resolveBinding(1, { modelId: 'remote', executionMode: 'plan', localFallbackModelId: 'local' })).toThrow('model_plan_qualification_required');
    available = false;
    expect(gateway.resolveBinding(1, { modelId: 'remote' })).toBeNull();
    expect(gateway.resolveBinding(1, { modelId: 'remote', localFallbackModelId: null })).toBeNull();
    expect(gateway.resolveBinding(1, { modelId: 'remote', localFallbackModelId: 'local' })).toMatchObject({ providerId: 'ariadne.local', modelId: 'local' });
    for (const localFallbackModelId of ['remote', 'missing', 'disabled']) {
      expect(gateway.resolveBinding(1, { modelId: 'remote', localFallbackModelId })).toBeNull();
    }
    expect(gateway.resolveBinding(1, { modelId: 'missing', localFallbackModelId: 'local' })).toBeNull();
    expect(() => gateway.resolveBinding(1, { modelId: 'remote', localFallbackModelId: 'local', requiresVision: true })).toThrow('model_vision_qualification_required');
  });
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
      toolCallCapability: 'unsupported' as const,
      contextWindowTokens: 32_768,
      tokenCounter: {
        countRequest: vi.fn(async () => ({
          tokens: 42,
          exact: true,
          method: 'model_tokenizer' as const,
          tokenizer: 'llama.cpp:local-exact'
        }))
      },
      chat
    };
    const localModels = {
      clients: () => [client]
    } as unknown as LocalModelService;
    const remote: ExactAgentModelInferenceRuntime = {
      inferExact: async () => ({ status: 'binding_unavailable' }),
      countRequestTokens: async () => ({ tokens: 1, exact: false, tokenizer: 'remote' }),
      hasExactBinding: () => false,
      resolveBinding: () => null,
      describeContextCapacity: () => null,
      describeExecutionQualification: () => null
    };
    const gateway = new RuntimeKernelModelInferenceGateway(
      remote,
      localModels,
      [],
      { modelId: 'local-exact', localFallbackModelId: '' },
      undefined,
      () => false
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
    await expect(gateway.countRequestTokens(request)).resolves.toEqual({
      tokens: 42,
      exact: true,
      tokenizer: 'llama.cpp:local-exact'
    });

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

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
import type { ModelQualitySummary } from '@ariadne/protocol/public';

describe('RuntimeKernelModelInferenceGateway', () => {
  function rankedGateway(scores:Record<string,ModelQualitySummary|null>,unqualified=new Set<string>(),disableLocal=false) {
    const remote:ExactAgentModelInferenceRuntime={inferExact:async()=>({status:'binding_unavailable'}),countRequestTokens:async()=>({tokens:1,exact:false,tokenizer:'fixture'}),
      hasExactBinding:()=>true,resolveBinding:()=>null,describeContextCapacity:()=>null,
      describeExecutionQualification:(binding)=>({supportsTextResponse:!unqualified.has(binding.modelId),supportsAgent:!unqualified.has(binding.modelId),supportsPlan:false,supportsVision:false})};
    const providers=['cloud-a','cloud-b'].map(model=>({providerId:'fixture',model,enabled:true}));
    const locals={clients:()=>[{name:'local',toolCallCapability:'native'}]} as unknown as LocalModelService;
    return new RuntimeKernelModelInferenceGateway(remote,locals,providers as never,'quality-first',undefined,()=>true,new Set(disableLocal?['local']:[]),(_provider,model)=>scores[model]??null);
  }
  const score=(passed:number,state:'current'|'expired'='current'):ModelQualitySummary=>({benchmarkId:'ariadne-text-quality-v1',benchmarkDigest:`sha256:${'a'.repeat(64)}`,
    passed,total:6,score:passed/6,state,evaluatedAt:'2026-10-04T03:00:00.000Z',validUntil:'2026-11-03T03:00:00.000Z'});
  it('quality-first selects measured local quality above cloud order',()=>{
    expect(rankedGateway({'cloud-a':score(2),'cloud-b':score(4),local:score(6)}).resolveBinding(1)?.modelId).toBe('local');
  });
  it('excludes expired, missing and unqualified scores and retains deterministic ties',()=>{
    expect(rankedGateway({'cloud-a':score(6,'expired'),'cloud-b':score(4),local:score(4)}).resolveBinding(1)?.modelId).toBe('cloud-b');
    expect(rankedGateway({'cloud-a':score(6),'cloud-b':score(3)},new Set(['cloud-a'])).resolveBinding(1)?.modelId).toBe('cloud-b');
  });
  it('reports missing current evidence rather than silently choosing the first cloud model',()=>{
    expect(()=>rankedGateway({local:score(6,'expired')}).resolveBinding(1)).toThrow('model_quality_evaluation_required');
  });
  it('preserves explicit selection and other strategies without requiring quality evidence',()=>{
    const gateway=rankedGateway({});expect(gateway.resolveBinding(1,{modelId:'local'})?.modelId).toBe('local');
    expect(gateway.resolveBinding(1,{routingStrategy:'cloud-first'})?.modelId).toBe('cloud-a');
    expect(gateway.resolveBinding(1,{routingStrategy:'privacy-first'})?.modelId).toBe('local');
  });
  it('does not allow quality scores to replace missing vision or Plan qualification',()=>{
    const gateway=rankedGateway({'cloud-a':score(6),local:score(6)});
    expect(()=>gateway.resolveBinding(1,{requiresVision:true})).toThrow('model_vision_qualification_required');
    expect(()=>rankedGateway({'cloud-a':score(6)},new Set(),true).resolveBinding(1,{executionMode:'plan'})).toThrow('model_plan_qualification_required');
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
      'local-first',
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

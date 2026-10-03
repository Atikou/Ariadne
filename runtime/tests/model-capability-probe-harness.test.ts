import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ExactAgentModelInferenceResult,
  ExactAgentModelInferenceRuntime
} from '../src/control/ports/AgentModelInference.js';
import { deriveModelCapabilities } from '../src/model/capability/ModelCapabilityQualification.js';
import { ModelCapabilityProbeHarness } from '../src/model/capability/ModelCapabilityProbeHarness.js';
import { ModelCapabilityRegistry } from '../src/model/capability/ModelCapabilityRegistry.js';

const roots: string[] = [];
const FINGERPRINT = `sha256:${'c'.repeat(64)}`;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ModelCapabilityProbeHarness', () => {
  it('preserves qualified text capability when the native Agent stage is rejected', async () => {
    let call = 0;
    const inferExact = vi.fn(async (request: Parameters<ExactAgentModelInferenceRuntime['inferExact']>[0]) => {
      call += 1;
      if (call <= 3) {
        await request.chunkObserver?.observe({ sequence: 1, channel: 'token', text: 'READY' });
        return completed([{ type: 'text', text: 'READY' }], 'stop');
      }
      return completed([{ type: 'text', text: '5' }], 'stop');
    });
    const registry = new ModelCapabilityRegistry(temporaryDatabase());
    const harness = new ModelCapabilityProbeHarness(runtime(inferExact), registry);

    const report = await harness.run({
      binding: { providerId: 'ariadne.local', modelId: 'text-only', settingsRevision: 1 },
      fingerprint: FINGERPRINT,
      signal: new AbortController().signal
    });

    expect(report).toMatchObject({
      textResponse: 'qualified',
      streamingText: 'qualified',
      nativeToolCalls: 'rejected',
      planControlCalls: 'rejected',
      failureCode: 'model_probe_native_tool_invalid'
    });
    expect(deriveModelCapabilities(report)).toEqual({
      supportsTextChat: true,
      supportsAgent: false,
      supportsPlan: false,
      supportsVision: false,
      qualificationState: 'qualified'
    });
    registry.close();
  });

  it('rejects only vision when text, Agent and Plan probes are qualified', async () => {
    const inferExact = vi.fn(async (
      request: Parameters<ExactAgentModelInferenceRuntime['inferExact']>[0]
    ) => {
      const toolNames = request.tools.map((tool) => tool.providerToolName);
      const hasImage = request.messages.some((message) => (
        message.content.some((block) => block.type === 'image')
      ));
      if (hasImage) return completed([{ type: 'text', text: 'VISION_REJECTED' }], 'stop');
      if (toolNames.includes('probe_calculate')) {
        const hasResult = request.messages.some((message) => (
          message.content.some((block) => block.type === 'tool_result')
        ));
        if (hasResult) return completed([{ type: 'text', text: '5' }], 'stop');
        const direct = request.messages.some((message) => (
          message.content.some((block) => (
            block.type === 'text' && block.text.includes('Answer directly')
          ))
        ));
        if (direct) return completed([{ type: 'text', text: 'READY' }], 'stop');
        return completed([{
          type: 'tool_call',
          toolCallId: 'probe-calculate-test',
          providerToolName: 'probe_calculate',
          input: { left: 2, right: 3 }
        }], 'tool_calls');
      }
      if (toolNames.includes('ariadne_control_ask_user')) {
        return completed([{
          type: 'tool_call',
          toolCallId: 'probe-ask-test',
          providerToolName: 'ariadne_control_ask_user',
          input: { question: { prompt: 'Which color?' } }
        }], 'tool_calls');
      }
      if (toolNames.includes('ariadne_control_propose_plan')) {
        return completed([{
          type: 'tool_call',
          toolCallId: 'probe-plan-test',
          providerToolName: 'ariadne_control_propose_plan',
          input: {
            plan: {
              summary: 'Inspect.',
              impactSummary: 'Read only.',
              steps: [{ title: 'Inspect', summary: 'Inspect.', impact: 'read_only' }]
            }
          }
        }], 'tool_calls');
      }
      request.chunkObserver?.observe({ sequence: 1, channel: 'token', text: 'READY' });
      return completed([{ type: 'text', text: 'READY' }], 'stop');
    });
    const registry = new ModelCapabilityRegistry(temporaryDatabase());
    const harness = new ModelCapabilityProbeHarness(runtime(inferExact), registry);

    const report = await harness.run({
      binding: { providerId: 'openai', modelId: 'vision-candidate', settingsRevision: 1 },
      fingerprint: FINGERPRINT,
      signal: new AbortController().signal,
      probeVision: true
    });

    expect(report).toMatchObject({
      textResponse: 'qualified',
      nativeToolCalls: 'qualified',
      planControlCalls: 'qualified',
      visionInput: 'rejected',
      failureCode: 'model_probe_vision_invalid'
    });
    expect(deriveModelCapabilities(report)).toMatchObject({
      supportsTextChat: true,
      supportsAgent: true,
      supportsPlan: true,
      supportsVision: false
    });
    registry.close();
  });
});

function runtime(
  inferExact: ExactAgentModelInferenceRuntime['inferExact']
): ExactAgentModelInferenceRuntime {
  return {
    inferExact,
    hasExactBinding: () => true,
    resolveBinding: () => null,
    describeContextCapacity: () => null,
    describeExecutionQualification: () => null,
    countRequestTokens: async () => ({ tokens: 1, exact: true, tokenizer: 'test' })
  };
}

function completed(
  contentBlocks: Extract<ExactAgentModelInferenceResult, { status: 'completed' }>['contentBlocks'],
  finishReason: 'stop' | 'tool_calls'
): ExactAgentModelInferenceResult {
  return {
    status: 'completed',
    contentBlocks,
    replay: {
      envelopeVersion: 1,
      adapter: 'embedded-local',
      finishReason,
      requestEnvelopeDigest: `sha256:${'d'.repeat(64)}`,
      contentBlocksDigest: `sha256:${'e'.repeat(64)}`
    }
  };
}

function temporaryDatabase(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-model-probe-'));
  roots.push(root);
  return path.join(root, 'model-capability.db');
}

import { describe, expect, it } from 'vitest';

import {
  planV3LongContext,
  type V3ModelContextGroup
} from '../src/adapters/model/V3LongContextLifecycle.js';

const HEADER_DIGEST = `sha256:${'a'.repeat(64)}`;

describe('v3 long-context token authority', () => {
  it('records the exact semantic compaction input and output evidence', () => {
    const planned = planV3LongContext({
      pinnedMessages: [textMessage('system', 'fixed protocol')],
      groups: Array.from({ length: 80 }, (_, index) => ({
        kind: 'conversation' as const,
        messages: [textMessage(
          index % 2 === 0 ? 'user' : 'assistant',
          `${index % 2 === 0 ? 'User intent' : 'Assistant outcome'} ${String(index)} ${'x'.repeat(500)}`
        )]
      })),
      capacity: { contextWindowTokens: 8_192, maxOutputTokens: 1_024 },
      requestHeaderDigest: HEADER_DIGEST
    });

    expect(planned.modelContext).toMatchObject({
      lifecycle: 'compacted',
      semanticCompaction: {
        protocol: 'ariadne.semantic-context-compaction.v1',
        sourceDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        summaryDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        sourceItems: expect.any(Number),
        selectedItems: expect.any(Number),
        omittedItems: expect.any(Number),
        summaryCharacters: expect.any(Number)
      }
    });
    const summary = planned.primaryMessages.find((message) => message.content.some((block) => (
      block.type === 'text' && block.text.includes('ariadne.semantic-context-compaction.v1')
    )));
    expect(summary).toBeDefined();
  });

  it('uses a matching Provider usage anchor in capacity decisions', () => {
    const pinnedMessages = [textMessage('system', 'fixed protocol')];
    const groups: readonly V3ModelContextGroup[] = Array.from(
      { length: 5 },
      (_, index) => ({
        kind: 'conversation' as const,
        messages: [{
          role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
          content: [{ type: 'text' as const, text: `${String(index)}:${'x'.repeat(3_000)}` }]
        }]
      })
    );
    const common = {
      pinnedMessages,
      groups,
      capacity: { contextWindowTokens: 8_192, maxOutputTokens: 1_024 },
      requestHeaderDigest: HEADER_DIGEST
    };

    const estimated = planV3LongContext(common);
    const anchored = planV3LongContext({
      ...common,
      usageBaseline: {
        attemptId: 'attempt-meter-anchor',
        anchor: {
          anchorVersion: 1,
          providerId: 'provider-meter',
          modelId: 'model-meter',
          settingsRevision: 1,
          requestHeaderDigest: HEADER_DIGEST,
          requestEnvelopeDigest: `sha256:${'b'.repeat(64)}`,
          estimatedInputTokens: 100,
          inputTokens: 2_100,
          outputTokens: 20,
          cacheReadInputTokens: 300,
          cacheWriteInputTokens: 100
        }
      }
    });

    expect(estimated.modelContext).toMatchObject({
      lifecycle: 'full',
      tokenMeter: { baseline: 'estimated', correctionTokens: 0 }
    });
    expect(anchored.modelContext).toMatchObject({
      lifecycle: 'compacted',
      omittedGroups: expect.any(Number),
      tokenMeter: {
        baseline: 'provider_usage',
        anchorAttemptId: 'attempt-meter-anchor',
        anchorProviderContextInputTokens: 2_500,
        correctionTokens: 2_400
      }
    });
    expect(anchored.primaryMessages.length).toBeLessThan(estimated.primaryMessages.length);
  });

  it('rejects a usage anchor from a different request header', () => {
    expect(() => planV3LongContext({
      pinnedMessages: [textMessage('system', 'fixed protocol')],
      groups: [{
        kind: 'conversation',
        messages: [textMessage('user', 'objective')]
      }],
      capacity: { contextWindowTokens: 8_192, maxOutputTokens: 1_024 },
      requestHeaderDigest: HEADER_DIGEST,
      usageBaseline: {
        attemptId: 'attempt-wrong-header',
        anchor: {
          anchorVersion: 1,
          providerId: 'provider-meter',
          modelId: 'model-meter',
          settingsRevision: 1,
          requestHeaderDigest: `sha256:${'c'.repeat(64)}`,
          requestEnvelopeDigest: `sha256:${'d'.repeat(64)}`,
          estimatedInputTokens: 100,
          inputTokens: 110,
          outputTokens: 10
        }
      }
    })).toThrow('agent_model_context_usage_anchor_header_mismatch');
  });
});

function textMessage(role: 'system' | 'user' | 'assistant', text: string) {
  return { role, content: [{ type: 'text' as const, text }] } as const;
}

import { describe, expect, it } from 'vitest';

import {
  compactSemanticContext,
  SEMANTIC_COMPACTION_PROTOCOL,
  type SemanticContextGroup
} from '../src/adapters/model/DeterministicSemanticContextCompactor.js';

describe('deterministic semantic context compactor', () => {
  it('preserves prior intent and outcomes with verifiable deterministic evidence', () => {
    const groups: readonly SemanticContextGroup[] = [
      conversation('user', 'Implement durable session recovery. Preserve the exact command identity.'),
      conversation('assistant', 'Session recovery was implemented and restart tests passed.'),
      conversation('user', `Investigate the remaining lifecycle gap. ${'detail '.repeat(120)}`),
      conversation('assistant', 'The remaining problem is semantic compaction, not persistence.')
    ];

    const first = compactSemanticContext(groups, 4_096);
    const second = compactSemanticContext(structuredClone(groups), 4_096);
    const payload = payloadOf(first.message);

    expect(first).toEqual(second);
    expect(first.message.role).toBe('user');
    expect(first.summaryCharacters).toBeLessThanOrEqual(4_096);
    expect(payload).toMatchObject({
      protocol: SEMANTIC_COMPACTION_PROTOCOL,
      schemaVersion: 1,
      method: 'deterministic_causal_extract',
      sourceDigest: first.sourceDigest,
      summaryDigest: first.summaryDigest,
      sourceItems: 4,
      selectedItems: first.selectedItems,
      omittedItems: first.omittedItems
    });
    expect(JSON.stringify(payload.items)).toContain('Implement durable session recovery.');
    expect(JSON.stringify(payload.items)).toContain('semantic compaction, not persistence.');

    const changed = compactSemanticContext([
      ...groups.slice(0, -1),
      conversation('assistant', 'The remaining problem changed.')
    ], 4_096);
    expect(changed.sourceDigest).not.toBe(first.sourceDigest);
    expect(changed.summaryDigest).not.toBe(first.summaryDigest);
  });

  it('keeps Tool outcome identity and owner-scoped retrieval without copying full output', () => {
    const longSecret = `PROTECTED_RESULT_${'x'.repeat(2_000)}`;
    const projected = compactSemanticContext([{
      kind: 'tool_exchange',
      messages: [{
        role: 'assistant',
        content: [{
          type: 'tool_call',
          toolCallId: 'call-search',
          providerToolName: 'workspace_search',
          input: { query: 'needle' }
        }]
      }, {
        role: 'user',
        content: [{
          type: 'tool_result',
          effectId: 'effect-search',
          toolCallId: 'call-search',
          status: 'succeeded',
          output: { matches: longSecret }
        }]
      }]
    }], 4_096);
    const payload = payloadOf(projected.message);
    const serialized = JSON.stringify(payload);

    expect(serialized).toContain('workspace_search');
    expect(serialized).toContain('workspace.effect_result_read');
    expect(serialized).toContain('effect-search');
    expect(serialized).not.toContain(longSecret);
    expect(serialized).toContain('sha256:');
  });

  it('honors a bounded recovery budget without splitting Unicode code points', () => {
    const projected = compactSemanticContext(Array.from({ length: 40 }, (_, index) => (
      conversation(
        index % 2 === 0 ? 'user' : 'assistant',
        `${String(index)} ${'🧭语义上下文。'.repeat(80)}`
      )
    )), 1_024);
    const serialized = textOf(projected.message);

    expect(serialized.length).toBeLessThanOrEqual(1_024);
    expect(serialized).not.toContain('\uFFFD');
    expect(projected.omittedItems).toBeGreaterThan(0);
  });
});

function conversation(
  role: 'user' | 'assistant',
  text: string
): SemanticContextGroup {
  return {
    kind: 'conversation',
    messages: [{ role, content: [{ type: 'text', text }] }]
  };
}

function textOf(message: ReturnType<typeof compactSemanticContext>['message']): string {
  const block = message.content[0];
  if (block?.type !== 'text') throw new Error('semantic_compaction_test_payload_missing');
  return block.text;
}

function payloadOf(message: ReturnType<typeof compactSemanticContext>['message']): Record<string, unknown> {
  return JSON.parse(textOf(message)) as Record<string, unknown>;
}

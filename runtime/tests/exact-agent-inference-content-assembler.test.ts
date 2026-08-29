import { describe, expect, it } from 'vitest';

import { ExactAgentInferenceContentAssembler } from '../src/adapters/model/ExactAgentInferenceContentAssembler.js';

function assembler() {
  return new ExactAgentInferenceContentAssembler({
    maxContentBytes: 32,
    maxReasoningBytes: 32,
    maxToolArgumentBytes: 64,
    maxToolCalls: 4,
    maxContentBlocks: 8
  });
}

describe('ExactAgentInferenceContentAssembler', () => {
  it('folds ordered text, reasoning, and fragmented native Tool calls', () => {
    const stream = assembler();
    stream.appendText({ sequence: 1, channel: 'reasoning', text: 'why' });
    stream.appendToolCall({
      index: 0,
      providerCallId: 'provider-private-id',
      providerToolName: 'exact_tool',
      argumentsDelta: '{"input":{"path":'
    });
    stream.appendText({ sequence: 2, channel: 'token', text: 'working' });
    stream.appendToolCall({ index: 0, argumentsDelta: '"src/a.ts"},"scope":[]}' });

    expect(stream.complete('tool_calls')).toEqual({
      contentBlocks: [{ type: 'reasoning', text: 'why' }, {
        type: 'tool_call',
        toolCallId: expect.stringMatching(/^native-[a-f0-9]{64}$/u),
        providerToolName: 'exact_tool',
        input: { input: { path: 'src/a.ts' }, scope: [] }
      }, { type: 'text', text: 'working' }],
      finalTextSequence: 2
    });
  });

  it('rejects gaps, malformed Tool JSON, identity conflicts, and finish drift', () => {
    const gap = assembler();
    expect(() => gap.appendText({ sequence: 2, channel: 'token', text: 'gap' }))
      .toThrow('exact_agent_stream_sequence_invalid');

    const malformed = assembler();
    malformed.appendToolCall({
      index: 0,
      providerCallId: 'call',
      providerToolName: 'tool',
      argumentsDelta: '{'
    });
    expect(() => malformed.complete('tool_calls'))
      .toThrow('exact_agent_stream_tool_arguments_invalid');

    const conflict = assembler();
    conflict.appendToolCall({
      index: 0,
      providerCallId: 'call-a',
      providerToolName: 'tool',
      argumentsDelta: '{}'
    });
    expect(() => conflict.appendToolCall({ index: 0, providerCallId: 'call-b' }))
      .toThrow('exact_agent_stream_tool_call_id_conflict');

    const finish = assembler();
    finish.appendText({ sequence: 1, channel: 'token', text: 'answer' });
    expect(() => finish.complete('tool_calls'))
      .toThrow('exact_agent_stream_finish_reason_conflict');
  });

  it('enforces independent UTF-8 and Tool argument limits', () => {
    const content = assembler();
    content.appendText({ sequence: 1, channel: 'token', text: '中'.repeat(10) });
    expect(() => content.appendText({ sequence: 2, channel: 'token', text: '文' }))
      .toThrow('exact_agent_stream_content_limit_exceeded');

    const args = assembler();
    args.appendToolCall({
      index: 0,
      providerCallId: 'call',
      providerToolName: 'tool',
      argumentsDelta: 'x'.repeat(64)
    });
    expect(() => args.appendToolCall({ index: 0, argumentsDelta: 'x' }))
      .toThrow('exact_agent_stream_tool_argument_limit_exceeded');
  });

  it('rejects invalid configured limits and use after completion', () => {
    expect(() => new ExactAgentInferenceContentAssembler({
      maxContentBytes: 0,
      maxReasoningBytes: 1,
      maxToolArgumentBytes: 1,
      maxToolCalls: 1,
      maxContentBlocks: 1
    })).toThrow('exact_agent_stream_content_limit_invalid');

    const stream = assembler();
    stream.appendText({ sequence: 1, channel: 'token', text: 'ok' });
    stream.complete('stop');
    expect(() => stream.appendText({ sequence: 2, channel: 'token', text: 'late' }))
      .toThrow('exact_agent_stream_already_completed');
  });
});

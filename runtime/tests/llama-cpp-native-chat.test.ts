import { describe, expect, it } from 'vitest';

import {
  toLlamaCppChatFunctions,
  toLlamaCppChatHistory
} from '../src/model/local/llamaCppNativeChat.js';

describe('llama.cpp native chat mapping', () => {
  it('keeps native function calls and their results in model history', () => {
    expect(toLlamaCppChatHistory([
      { role: 'user', content: 'Read one file.' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'README.md' } }]
      },
      {
        role: 'tool',
        toolCallId: 'call-1',
        content: JSON.stringify({ status: 'succeeded', output: { content: 'ok' } })
      }
    ])).toEqual([
      { type: 'user', text: 'Read one file.' },
      {
        type: 'model',
        response: [{
          type: 'functionCall',
          name: 'read_file',
          params: { path: 'README.md' },
          result: { status: 'succeeded', output: { content: 'ok' } }
        }]
      }
    ]);
  });

  it('maps Tool schemas to llama.cpp functions without serializing them into text', () => {
    expect(toLlamaCppChatFunctions([{
      name: 'read_file',
      description: 'Read one file.',
      parameters: {
        type: 'object',
        required: ['path'],
        properties: { path: { type: 'string' } }
      }
    }])).toEqual({
      read_file: {
        description: 'Read one file.',
        params: {
          type: 'object',
          required: ['path'],
          properties: { path: { type: 'string' } }
        }
      }
    });
  });

  it('rejects a native call whose result is absent', () => {
    expect(() => toLlamaCppChatHistory([
      { role: 'user', content: 'Read one file.' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'README.md' } }]
      }
    ])).toThrow('llama.cpp 工具调用历史缺少对应结果');
  });
});

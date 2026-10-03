import type {
  ChatHistoryItem,
  ChatModelFunctions
} from 'node-llama-cpp';

import type { RuntimeGeneratePayload } from './runtimeProtocol.js';

/** Maps Ariadne native Tool history to the llama.cpp chat wrapper without text serialization. */
export function toLlamaCppChatHistory(
  messages: RuntimeGeneratePayload['messages']
): ChatHistoryItem[] {
  const toolResults = new Map(messages.flatMap((message) => (
    message.role === 'tool' && message.toolCallId
      ? [[message.toolCallId, parseToolResult(message.content)] as const]
      : []
  )));
  const history: ChatHistoryItem[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      history.push({ type: 'system', text: message.content });
      continue;
    }
    if (message.role === 'user') {
      history.push({ type: 'user', text: message.content });
      continue;
    }
    if (message.role === 'assistant') {
      const response: Extract<ChatHistoryItem, { type: 'model' }>['response'] = [];
      if (message.content.length > 0) response.push(message.content);
      for (const call of message.toolCalls ?? []) {
        if (!toolResults.has(call.id)) throw new Error('llama.cpp 工具调用历史缺少对应结果');
        response.push({
          type: 'functionCall',
          name: call.name,
          params: call.arguments,
          result: toolResults.get(call.id)
        });
      }
      history.push({ type: 'model', response });
    }
  }
  if (history.length === 0 || !history.some((item) => item.type === 'user')) {
    throw new Error('llama.cpp 推理历史缺少用户输入');
  }
  return history;
}

export function toLlamaCppChatFunctions(
  tools: NonNullable<RuntimeGeneratePayload['tools']>
): ChatModelFunctions {
  return Object.fromEntries(tools.map((tool) => [tool.name, {
    description: tool.description,
    params: tool.parameters
  }])) as ChatModelFunctions;
}

export function stableLlamaCppCallDigest(name: string, params: unknown): string {
  let hash = 2166136261;
  const value = `${name}\u0000${JSON.stringify(params)}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function parseToolResult(content: string): unknown {
  return JSON.parse(content) as unknown;
}

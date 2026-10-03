import { type RuntimeMessage } from '@renderer/core/runtime/runtime-store';
import { type ConversationNode } from './conversation-node';

const nodes = new WeakMap<RuntimeMessage, ConversationNode>();
export function toConversationNode(message: RuntimeMessage): ConversationNode {
  const previous = nodes.get(message);
  if (previous !== undefined) return previous;
  const content = message.content;
  const summary = content
    || message.reasoning?.content
    || (message.status === 'streaming' ? '正在处理…' : '');
  const kind = message.role === 'user'
    ? 'user'
    : message.status === 'streaming'
      ? 'streaming'
      : message.status === 'interrupted' || message.status === 'failed'
        ? 'error'
        : 'assistant';
  const node: ConversationNode = {
    id: message.messageId,
    kind,
    sender: message.role === 'user' ? '你' : 'Ariadne',
    time: new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    summary: summary.slice(0, 160),
    content,
    ...(message.attachments === undefined
      ? {}
      : { attachments: message.attachments.map((attachment) => ({ ...attachment })) }),
    status: message.status,
    ...(message.runId ? { runId: message.runId } : {}),
    ...(message.reference ? { reference: { ...message.reference } } : {}),
    ...(message.processingDurationMs !== undefined
      ? { processingDurationMs: message.processingDurationMs }
      : {}),
    ...(message.reasoning ? { reasoning: message.reasoning } : {}),
    ...(message.deliveryState ? { deliveryState: message.deliveryState } : {}),
    ...(message.error ? { error: message.error } : {})
  };
  nodes.set(message, node);
  return node;
}

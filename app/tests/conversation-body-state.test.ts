import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { ConversationMessage } from '../src/renderer/src/modules/chat/ConversationMessage';
import { toConversationNode } from '../src/renderer/src/modules/chat/ChatMessageProjection';
import type { RuntimeMessage } from '../src/renderer/src/core/runtime/runtime-projection-presenter';
it.each(['user', 'assistant'] as const)('renders unread %s metadata as an explicit body action without a fake empty content or copy action', role => {
  const metadata: RuntimeMessage = { messageId: 'message-a', sessionId: 'session-a', role, status: 'completed', bodyState: 'unloaded',
    bodyReadToken: `sha256:${'a'.repeat(64)}`, createdAt: '2032-01-01T00:00:00.000Z' };
  const node = toConversationNode(metadata);
  expect(node).not.toHaveProperty('content');
  const html = renderToStaticMarkup(createElement(ConversationMessage, { node, activities: [], onCopy: async () => undefined, onLoadBody: async () => undefined }));
  expect(html).toContain('正文未加载'); expect(html).toContain('读取正文'); expect(html).not.toMatch(/复制消息|复制回答|正在处理/u);
  const loaded = toConversationNode({ ...metadata, bodyState: 'loaded', content: 'COMPLETE_BODY' });
  const completeHtml = renderToStaticMarkup(createElement(ConversationMessage, { node: loaded, activities: [], onCopy: async () => undefined }));
  expect(completeHtml).toContain('COMPLETE_BODY'); expect(completeHtml).not.toContain('正文未加载');
});

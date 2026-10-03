import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConversationMessage } from '../src/renderer/src/modules/chat/ConversationMessage';
import { toConversationNode } from '../src/renderer/src/modules/chat/ChatMessageProjection';
import type { RuntimeMessage } from '../src/renderer/src/core/runtime/runtime-store';

function renderMessage(role: 'user' | 'assistant', content: string, status: RuntimeMessage['status'] = 'completed'): string {
  return renderToStaticMarkup(createElement(ConversationMessage, {
    node: toConversationNode({ messageId: 'message-a', sessionId: 'session-a', role, content, status,
      createdAt: '2026-09-05T00:00:00.000Z' }), activities: [], onCopy: async () => {}
  }));
}

const rendererRoot = join(process.cwd(), 'src', 'renderer', 'src');

describe('chat message actions', () => {
  it('keeps conversation selection visually neutral', async () => {
    const styles = await readFile(join(rendererRoot, 'app', 'styles.css'), 'utf8');

    expect(styles).not.toMatch(/\.conversation-node\.is-selected\s*\{/);
    expect(styles).not.toMatch(/\.conversation-node\s*\{[^}]*(?:background|border|box-shadow):/);
  });

  it('shares the typed clipboard action with user messages and assistant answers', async () => {
    const panel = await readFile(join(rendererRoot, 'modules', 'chat', 'ConversationMessageRow.tsx'), 'utf8');
    expect(renderMessage('user', 'User text')).toContain('aria-label="复制消息"');
    expect(renderMessage('assistant', 'Answer text')).toContain('aria-label="复制回答"');
    expect(panel).toContain('services.clipboard.writeText({ text })');
    expect(panel).not.toContain('navigator.clipboard');
    expect(panel).not.toMatch(/mock/i);
  });

  it('renders the exact message text without creating layout paragraphs', async () => {
    const [panel, styles] = await Promise.all([
      readFile(join(rendererRoot, 'modules', 'chat', 'ChatPanel.tsx'), 'utf8'),
      readFile(join(rendererRoot, 'app', 'styles.css'), 'utf8')
    ]);

    const content = '  first line\n\nsecond line  ';
    expect(renderMessage('user', content)).toContain(`<p class="message-content">${content}</p>`);
    expect(panel).toContain('const message = draft;');
    expect(panel).toContain('message.trim().length === 0 && images.length === 0');
    expect(styles).toMatch(/\.message-content\s*\{[^}]*white-space:\s*break-spaces;/);
    expect(styles).toMatch(/\.user-message \.message-content\s*\{[^}]*width:\s*fit-content;/);
  });

  it('renders partial answer text before completion and preserves explicit failure states', () => {
    const streaming = renderMessage('assistant', 'Partial answer', 'streaming');
    expect(streaming).toContain('Partial answer');
    expect(streaming).not.toContain('assistant-processing-placeholder');
    expect(renderMessage('assistant', '', 'streaming')).toContain('正在处理…');
    expect(renderMessage('assistant', 'Preserved text', 'interrupted')).toContain('回复生成中断');
    expect(renderMessage('assistant', '', 'failed')).toContain('回复生成失败');
  });

  it('uses an avatar-free compact user bubble', async () => {
    const [panel, styles] = await Promise.all([
      readFile(join(rendererRoot, 'modules', 'chat', 'ChatPanel.tsx'), 'utf8'),
      readFile(join(rendererRoot, 'app', 'styles.css'), 'utf8')
    ]);

    expect(panel).not.toContain('message-avatar');
    expect(panel).not.toMatch(/\b(?:Bot|User)\b/);
    expect(styles).not.toContain('.message-avatar');
    expect(styles).toMatch(/\.user-message \.message-content\s*\{[^}]*background:\s*var\(--user-message-bg\);/);
    expect(styles).toMatch(/\.user-message \.message-content\s*\{[^}]*border:\s*0;[^}]*border-radius:\s*var\(--radius-lg\);/);
  });

  it('uses the user-message end edge as a hard boundary for assistant content', async () => {
    const styles = await readFile(join(rendererRoot, 'app', 'styles.css'), 'utf8');

    expect(styles).toMatch(/\.user-message,\s*\.assistant-message\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/);
    expect(styles).toMatch(/\.user-message-block,\s*\.assistant-message-block\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/);
    expect(styles).toMatch(/\.assistant-message-block\s*\{[^}]*overflow-x:\s*clip;/);
    expect(styles).toMatch(/\.markdown-content\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*overflow-x:\s*clip;/);
    expect(styles).toMatch(/\.markdown-content\s*>\s*\*\s*\{[^}]*max-width:\s*100%;/);
    expect(styles).not.toContain('.user-message-block > .user-message');
    expect(styles).not.toContain('.assistant-message-block > .assistant-message');
  });
});

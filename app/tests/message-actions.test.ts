import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = join(process.cwd(), 'src', 'renderer', 'src');

describe('chat message actions', () => {
  it('keeps conversation selection visually neutral', async () => {
    const styles = await readFile(join(rendererRoot, 'app', 'styles.css'), 'utf8');

    expect(styles).not.toMatch(/\.conversation-node\.is-selected\s*\{/);
    expect(styles).not.toMatch(/\.conversation-node\s*\{[^}]*(?:background|border|box-shadow):/);
  });

  it('shares the typed clipboard action with user messages and assistant answers', async () => {
    const panel = await readFile(join(rendererRoot, 'modules', 'chat', 'ChatPanel.tsx'), 'utf8');

    expect(panel).toContain('function MessageCopyButton');
    expect(panel).toContain("subject={isUser ? '消息' : '回答'}");
    expect(panel).toContain('function ConversationMessage');
    expect(panel).toContain('onCopy={(text) => services.clipboard.writeText({ text })}');
    expect(panel).toContain('event.stopPropagation();');
    expect(panel).toContain('const text = node.content ?? node.summary;');
    expect(panel).not.toContain('navigator.clipboard');
    expect(panel).not.toMatch(/mock/i);
  });

  it('renders the exact message text without creating layout paragraphs', async () => {
    const [panel, styles] = await Promise.all([
      readFile(join(rendererRoot, 'modules', 'chat', 'ChatPanel.tsx'), 'utf8'),
      readFile(join(rendererRoot, 'app', 'styles.css'), 'utf8')
    ]);

    expect(panel).toContain('<p className="message-content">{visibleText}</p>');
    expect(panel).toContain('const visibleText = formalAnswerVisible ? text');
    expect(panel).not.toContain('text.split(');
    expect(panel).toContain('const message = draft;');
    expect(panel).toContain('if (!message.trim()');
    expect(styles).toMatch(/\.message-content\s*\{[^}]*white-space:\s*break-spaces;/);
    expect(styles).toMatch(/\.user-message \.message-content\s*\{[^}]*width:\s*fit-content;/);
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

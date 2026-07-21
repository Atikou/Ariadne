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
    expect(panel).toContain('<MessageCopyButton text={text} subject="消息" onCopy={onCopy} />');
    expect(panel).toContain('<MessageCopyButton text={text} subject="回答" onCopy={onCopy} />');
    expect(panel).toContain('return <AssistantConversationMessage node={node} onCopy={onCopy} />;');
    expect(panel).toContain("onCopy={(text) => services.clipboard.writeText({ text })}");
    expect(panel).toContain('event.stopPropagation();');
    expect(panel).toContain('const text = node.content ?? node.summary;');
    expect(panel).not.toContain('navigator.clipboard');
    expect(panel).not.toContain('defaultAssistantParagraphs');
  });
});

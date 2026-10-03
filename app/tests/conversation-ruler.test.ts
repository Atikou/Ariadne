import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRulerEntries, resolveRulerCurrentId } from '../src/shared/ruler-model';

function createNodes(count: number): Array<{ id: string }> {
  return Array.from({ length: count }, (_, index) => ({
    id: `node-${index}`
  }));
}

describe('conversation overview ruler', () => {
  it('feeds the ruler from persisted Runtime messages instead of mock history', async () => {
    const chatSource = await readFile(
      join(process.cwd(), 'src', 'renderer', 'src', 'modules', 'chat', 'ChatPanel.tsx'),
      'utf8'
    );

    expect(chatSource).toContain('runtime.messages.map(toConversationNode)');
    expect(chatSource).toContain('<ConversationOverviewRuler nodes={nodes}');
    expect(chatSource).not.toMatch(/mock/i);
  });

  it('renders exactly one ordered tick for every conversation without aggregation', () => {
    const nodes = createNodes(37);
    const entries = createRulerEntries(nodes, nodes[0]!.id);
    const renderedIds = entries.map((entry) => entry.node.id);

    expect(renderedIds).toEqual(nodes.map((node) => node.id));
    expect(new Set(renderedIds).size).toBe(nodes.length);
  });

  it('uses five animated length levels around the selected tick', () => {
    const levels = createRulerEntries(createNodes(9), 'node-4').map((entry) => entry.emphasisLevel);

    expect(levels).toEqual([0, 1, 2, 3, 4, 3, 2, 1, 0]);
  });

  it('restores default lengths while preserving the current-position color target', () => {
    const nodes = createNodes(9);

    expect(createRulerEntries(nodes, null).map((entry) => entry.emphasisLevel)).toEqual(Array(9).fill(0));
    expect(resolveRulerCurrentId(nodes, 'node-2', 'node-4')).toBe('node-2');
    expect(resolveRulerCurrentId(nodes, 'missing', 'node-4')).toBe('node-4');
    expect(resolveRulerCurrentId(nodes, null, null)).toBeNull();
  });

  it('returns no ruler for an empty conversation', () => {
    expect(createRulerEntries([], null)).toEqual([]);
  });

  it('keeps the rail bounded and tweens one focus indicator between ticks', async () => {
    const [styles, rulerSource] = await Promise.all([
      readFile(join(process.cwd(), 'src', 'renderer', 'src', 'app', 'styles.css'), 'utf8'),
      readFile(
        join(process.cwd(), 'src', 'renderer', 'src', 'modules', 'chat', 'ConversationOverviewRuler.tsx'),
        'utf8'
      )
    ]);

    expect(styles).toMatch(/\.conversation-ruler \{[^}]*height: min\(76%, 320px\)/);
    expect(styles).toMatch(/\.ruler-scroll \{[^}]*overflow-y: auto/);
    expect(styles).toMatch(/\.ruler-scroll \{[^}]*overscroll-behavior: contain/);
    expect(styles).toMatch(/\.ruler-scroll::\-webkit-scrollbar \{ display: none; \}/);
    expect(styles).toMatch(/\.ruler-tick::before \{[^}]*transition: width 280ms cubic-bezier\(\.22, 1, \.36, 1\)/);
    expect(styles).toMatch(/\.ruler-tick--level-4::before \{ width: 20px;/);
    expect(styles).toMatch(/\.ruler-focus-indicator \{[^}]*will-change: width, transform;[^}]*transition: width 280ms[^}]*transform 320ms cubic-bezier\(\.22, 1, \.36, 1\)/);
    expect(rulerSource).toContain('className="ruler-focus-indicator"');
    expect(rulerSource).toContain('tickBounds.top - trackBounds.top');
    expect(rulerSource).not.toContain("' is-emphasized'");
  });
});

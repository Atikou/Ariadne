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
  it('provides enough non-blank mock history to exercise ruler overflow', async () => {
    const mockSource = await readFile(
      join(process.cwd(), 'src', 'renderer', 'src', 'modules', 'chat', 'mock-chat-data.ts'),
      'utf8'
    );

    expect(mockSource).toContain('const overflowHistory: ConversationNode[] = Array.from({ length: 24 }');
    expect(mockSource).toContain("case 'blank': return [];");
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

  it('keeps the rail bounded and wheel-scrollable without a visible scrollbar', async () => {
    const styles = await readFile(join(process.cwd(), 'src', 'renderer', 'src', 'app', 'styles.css'), 'utf8');

    expect(styles).toMatch(/\.conversation-ruler \{[^}]*height: min\(76%, 320px\)/);
    expect(styles).toMatch(/\.ruler-scroll \{[^}]*overflow-y: auto/);
    expect(styles).toMatch(/\.ruler-scroll \{[^}]*overscroll-behavior: contain/);
    expect(styles).toMatch(/\.ruler-scroll::\-webkit-scrollbar \{ display: none; \}/);
    expect(styles).toMatch(/\.ruler-tick::before \{[^}]*transition: width 220ms/);
    expect(styles).toMatch(/\.ruler-tick--level-4::before \{ width: 20px;/);
    expect(styles).toMatch(/\.ruler-tick\.is-emphasized::before \{[^}]*background: var\(--text-1\);[^}]*opacity: 1;/);
  });
});

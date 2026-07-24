import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getCenteredScrollDelta, getNearestScrollDelta, isScrollNearBottom } from '../src/shared/scroll-geometry';

async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  }));
  return nested.flat();
}

describe('renderer scroll boundaries', () => {
  it('calculates scrolling relative to the owning viewport only', () => {
    expect(getNearestScrollDelta(100, 300, 140, 160, 18)).toBe(0);
    expect(getNearestScrollDelta(100, 300, 105, 115, 18)).toBe(-13);
    expect(getNearestScrollDelta(100, 300, 290, 305, 18)).toBe(23);
    expect(getCenteredScrollDelta(100, 200, 240, 40)).toBe(60);
  });

  it('distinguishes following the latest message from reading older content', () => {
    expect(isScrollNearBottom(600, 400, 1000)).toBe(true);
    expect(isScrollNearBottom(578, 400, 1000)).toBe(true);
    expect(isScrollNearBottom(560, 400, 1000)).toBe(false);
    expect(isScrollNearBottom(0, 600, 400)).toBe(true);
  });

  it('does not use ancestor-scrolling DOM APIs inside the fixed desktop shell', async () => {
    const rendererRoot = join(process.cwd(), 'src', 'renderer', 'src');
    const files = await collectSourceFiles(rendererRoot);
    const offenders: string[] = [];

    for (const file of files) {
      if (/\.scrollIntoView\s*\(/.test(await readFile(file, 'utf8'))) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });

  it('pins the React root to the Electron viewport', async () => {
    const styles = await readFile(join(process.cwd(), 'src', 'renderer', 'src', 'app', 'styles.css'), 'utf8');

    expect(styles).toMatch(/#root \{[^}]*position: fixed;[^}]*inset: 0;[^}]*overflow: hidden;/);
    expect(styles).toMatch(/\.workspace-frame \{[^}]*overflow: hidden;/);
    expect(styles).not.toMatch(/\.ariadne-dockview-theme\s+\.dv-view[^{}]*\{[^}]*overflow:\s*visible;/);
  });

  it('keeps persistent panel overlays inside the module frame', async () => {
    const styles = await readFile(join(process.cwd(), 'src', 'renderer', 'src', 'app', 'styles.css'), 'utf8');

    expect(styles).toMatch(
      /\.dv-groupview:is\(\.dv-groupview-header-top, \.dv-groupview-header-bottom\) > \.dv-content-container \{[^}]*min-width:\s*0;[^}]*margin-inline-end:\s*1px;/
    );
    expect(styles).toMatch(
      /\.chat-panel \{[^}]*grid-template-columns:\s*clamp\([^;]+\) minmax\(0, 1fr\);/
    );
    expect(styles).toMatch(/\.chat-conversation \{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/);
    expect(styles).not.toMatch(/\.chat-(?:panel|header) \{[^}]*(?:border-right|margin-right:\s*-|width:\s*calc\()/);
  });
});

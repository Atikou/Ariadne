import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { activateEdgeTab } from '../src/shared/edge-tab-policy';

const rendererRoot = join(process.cwd(), 'src', 'renderer', 'src');

describe('bottom edge workspace layout', () => {
  it('rebuilds structural edge groups when resetting the workspace', async () => {
    const workspace = await readFile(join(rendererRoot, 'app', 'Workspace.tsx'), 'utf8');

    expect(workspace).toContain("const EDGE_POSITIONS = ['top', 'right', 'bottom', 'left'] as const");
    expect(workspace).toMatch(
      /export function resetWorkspace[\s\S]*?getEdgeGroup\(position\)[\s\S]*?removeEdgeGroup\(position\);[\s\S]*?api\.clear\(\);[\s\S]*?addDefaultLayout\(api, registry\);/
    );
  });

  it('does not mutate the persisted layout from a one-way resize observer', async () => {
    const workspace = await readFile(join(rendererRoot, 'app', 'Workspace.tsx'), 'utf8');

    expect(workspace).not.toContain('ResizeObserver');
    expect(workspace).not.toMatch(/getEdgeGroup\(['"]bottom['"]\)\?\.collapse\(\)/);
  });

  it('creates every bottom tool module in an expanded, resizable edge group', async () => {
    const moduleFiles = [
      join(rendererRoot, 'modules', 'tool-output', 'index.ts'),
      join(rendererRoot, 'modules', 'terminal', 'index.ts'),
      join(rendererRoot, 'modules', 'logs', 'index.ts')
    ];

    for (const moduleFile of moduleFiles) {
      const source = await readFile(moduleFile, 'utf8');
      expect(source).toContain("position: 'bottom'");
      expect(source).toContain('initialSize: 230');
      expect(source).toContain('collapsedSize: 44');
      expect(source).toContain('collapsed: false');
    }
  });

  it('keeps an expanded edge group open when its active tab is clicked again', () => {
    const calls: string[] = [];
    expect(activateEdgeTab({
      isEdgeGroup: true,
      isTabAction: false,
      setActive: () => calls.push('setActive'),
      expand: () => calls.push('expand')
    })).toBe(true);
    expect(calls).toEqual(['setActive', 'expand']);

    expect(activateEdgeTab({
      isEdgeGroup: true,
      isTabAction: true,
      setActive: () => calls.push('unexpected'),
      expand: () => calls.push('unexpected')
    })).toBe(false);
    expect(activateEdgeTab({
      isEdgeGroup: false,
      isTabAction: false,
      setActive: () => calls.push('unexpected'),
      expand: () => calls.push('unexpected')
    })).toBe(false);
    expect(calls).toEqual(['setActive', 'expand']);
  });

  it('lets the custom tab own the full Dockview tab hit area', async () => {
    const styles = await readFile(join(rendererRoot, 'app', 'styles.css'), 'utf8');

    expect(styles).toMatch(/\.ariadne-dockview-theme \.dv-tab \{[^}]*padding: 0;/);
    expect(styles).toMatch(/\.module-tab \{[^}]*width: 100%;[^}]*height: 100%;/);
  });

  it('uses a consistent active-tab silhouette', async () => {
    const styles = await readFile(join(rendererRoot, 'app', 'styles.css'), 'utf8');
    expect(styles).toMatch(/\.ariadne-dockview-theme \.dv-tab\.dv-active-tab \{[^}]*border-radius:\s*var\(--radius-lg\)\s+var\(--radius-lg\)\s+0\s+0;/);
    expect(styles).toMatch(/\.ariadne-dockview-theme \.dv-tab \{[^}]*transition:\s*border-radius 120ms ease;/);
    expect(styles).not.toMatch(/\.ariadne-dockview-theme \.dv-tab \{[^}]*transition:[^}]*(?:background-color|\bcolor\b)/);
    expect(styles).toMatch(/\.ariadne-dockview-theme \.dv-tab\.dv-active-tab \{[^}]*background:\s*var\(--module-tab-surface\) !important;/);
    expect(styles).toContain('.dv-groupview:is(.dv-groupview-header-top, .dv-groupview-header-bottom)');
    expect(styles).toMatch(/\.ariadne-dockview-theme \.dv-groupview \{[^}]*border-radius:\s*var\(--radius-md\);/);
  });

  it('selects the tool edge group before returning focus to the main chat workspace', async () => {
    const workspace = await readFile(join(rendererRoot, 'app', 'Workspace.tsx'), 'utf8');
    const moduleTab = await readFile(join(rendererRoot, 'app', 'ModuleTab.tsx'), 'utf8');

    expect(workspace).toMatch(
      /getEdgeGroup\('bottom'\)\?\.expand\(\)[\s\S]*?getPanel\(MODULE_IDS\.toolOutput\)[\s\S]*?getPanel\(MODULE_IDS\.agentStatus\)[\s\S]*?getPanel\(MODULE_IDS\.chat\)/
    );
    expect(moduleTab).toContain('onClickCapture');
    expect(moduleTab).toContain('activateEdgeTab');
  });

  it('uses the complete Dockview base theme and migrates layouts created by the reduced shell', async () => {
    const workspace = await readFile(join(rendererRoot, 'app', 'Workspace.tsx'), 'utf8');
    const styles = await readFile(join(rendererRoot, 'app', 'styles.css'), 'utf8');

    expect(workspace).toContain('themeAbyss');
    expect(workspace).toContain('...themeAbyss');
    expect(workspace).toContain("className: 'dockview-theme-abyss ariadne-dockview-theme'");
    expect(workspace).toContain('LAYOUT_REVISION_KEY');
    expect(workspace).toContain('deserializeLayout(saved.layout)');
    expect(styles).toContain('--dv-group-view-background-color: var(--module-tab-strip);');
    expect(styles).toContain('--dv-separator-border: transparent;');
    expect(styles).toContain('--dv-sash-color: transparent;');
  });

  it('does not expose the workspace API until layout restoration has finished', async () => {
    const workspace = await readFile(join(rendererRoot, 'app', 'Workspace.tsx'), 'utf8');
    const restoreStart = workspace.indexOf('void restoreLayout(api, registry)');
    const finallyStart = workspace.indexOf('.finally(() => {', restoreStart);
    const apiReady = workspace.indexOf('onApiReady(api);', restoreStart);

    expect(restoreStart).toBeGreaterThan(-1);
    expect(finallyStart).toBeGreaterThan(restoreStart);
    expect(apiReady).toBeGreaterThan(finallyStart);
  });
});

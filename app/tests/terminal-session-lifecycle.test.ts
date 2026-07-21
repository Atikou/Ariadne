import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = join(process.cwd(), 'src', 'renderer', 'src');

describe('terminal session lifecycle', () => {
  it('keeps every started shell mounted while switching the visible terminal', async () => {
    const panel = await readFile(join(rendererRoot, 'modules', 'terminal', 'TerminalPanel.tsx'), 'utf8');
    const styles = await readFile(join(rendererRoot, 'app', 'styles.css'), 'utf8');

    expect(panel).toContain('startedShells.has(value)');
    expect(panel).toContain('key={`${value}-${restartKeys[value]}`}');
    expect(panel).toContain("active={activeShell === value}");
    expect(panel).toContain('}, [onMetadata, services, shell]);');
    expect(styles).toContain('.terminal-viewport.is-active { display: block; }');
  });

  it('updates live xterm canvases when the global theme changes', async () => {
    const panel = await readFile(join(rendererRoot, 'modules', 'terminal', 'TerminalPanel.tsx'), 'utf8');

    expect(panel).toContain('new MutationObserver');
    expect(panel).toContain("attributeFilter: ['data-theme']");
    expect(panel).toContain('terminal.options.theme = readTerminalTheme();');
    expect(panel).toContain('themeObserver.disconnect();');
  });
});

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = join(process.cwd(), 'src', 'renderer', 'src');

describe('terminal session lifecycle', () => {
  it('keeps every started shell mounted while switching the visible terminal', async () => {
    const panel = await readFile(join(rendererRoot, 'modules', 'terminal', 'TerminalPanel.tsx'), 'utf8');
    const styles = await readFile(join(rendererRoot, 'app', 'styles.css'), 'utf8');

    expect(panel).toContain('startedShells.has(value)');
    expect(panel).toContain('key={`${value}-${workspaceId}-${restartKeys[value]}`}');
    expect(panel).toContain("active={activeShell === value}");
    expect(panel).toContain('}, [onMetadata, services, shell, workspaceId]);');
    expect(styles).toContain('.terminal-viewport.is-active { display: block; }');
  });

  it('updates live xterm canvases when the global theme changes', async () => {
    const panel = await readFile(join(rendererRoot, 'modules', 'terminal', 'TerminalPanel.tsx'), 'utf8');

    expect(panel).toContain('new MutationObserver');
    expect(panel).toContain("attributeFilter: ['data-theme']");
    expect(panel).toContain('terminal.options.theme = readTerminalTheme();');
    expect(panel).toContain('themeObserver.disconnect();');
  });

  it('uses the ConPTY DLL host so Electron is never reused as the helper process', async () => {
    const service = await readFile(join(process.cwd(), 'src', 'main', 'services', 'terminal-service.ts'), 'utf8');
    expect(service).toContain('useConptyDll: true');
    expect(service).toContain('const cwd = this.resolveWorkingDirectory(request.workspaceId);');
    expect(service).toContain("owner.once('destroyed', listener)");
  });

  it('binds each new or restarted shell to an explicit selected workspace', async () => {
    const panel = await readFile(join(rendererRoot, 'modules', 'terminal', 'TerminalPanel.tsx'), 'utf8');

    expect(panel).toContain('onSelectedWorkspaceChanged');
    expect(panel).toContain('[shell]: selectedWorkspaceId');
    expect(panel).toContain('[activeShell]: selectedWorkspaceId');
    expect(panel).toContain('workspaceId={workspaceId}');
    expect(panel).toContain('workspaceId,');
    expect(panel).toContain("session.workspaceId !== workspaceId");
  });
});

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  }));
  return nested.flat();
}

describe('Ariadne desktop architecture boundary', () => {
  it('keeps the Agent backend behind one Main-owned, portless Runtime supervisor', async () => {
    const files = await collectSourceFiles(join(process.cwd(), 'src'));
    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const normalized = file.replaceAll('\\', '/');
      const isRuntimeHost = normalized.includes('/src/main/runtime/');
      if (/createServer\s*\(|\.listen\s*\(|\bfetch\s*\(|node:https?|https?\.request\s*\(/.test(source)) {
        offenders.push(file);
      } else if (!isRuntimeHost && /child_process|node:child_process|@ariadne\/protocol\/host/.test(source)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps every desktop module registered while sharing only the public Runtime contract', async () => {
    const registry = await readFile(join(process.cwd(), 'src', 'renderer', 'src', 'core', 'modules', 'builtin-modules.ts'), 'utf8');
    for (const moduleName of [
      'chatModule',
      'agentStatusModule',
      'agentPlanModule',
      'toolOutputModule',
      'terminalModule',
      'logsModule',
      'fileExplorerModule',
      'permissionsModule',
      'settingsModule'
    ]) {
      expect(registry).toContain(moduleName);
    }
    expect(registry).not.toContain('conversationsModule');

    const contract = await readFile(join(process.cwd(), 'src', 'renderer', 'src', 'core', 'modules', 'module-contract.ts'), 'utf8');
    expect(contract).not.toMatch(/@ariadne\/protocol\/host|child_process|node:child_process/);
  });

  it('keeps Renderer isolated behind the fixed Preload bridge', async () => {
    const preload = await readFile(join(process.cwd(), 'src', 'preload', 'index.ts'), 'utf8');
    const mainIpc = await readFile(join(process.cwd(), 'src', 'main', 'ipc', 'register-ipc.ts'), 'utf8');
    const html = await readFile(join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
    expect(preload).not.toMatch(/\bfetch\s*\(|\b(?:baseUrl|port|token)\b/i);
    expect(preload).not.toMatch(/@ariadne\/protocol\/host|child_process|node:child_process/);
    expect(preload).toContain('runtime:');
    expect(preload).toContain('getStatus:');
    expect(preload).toContain('request:');
    expect(preload).toContain('onEvent:');
    expect(preload).toContain('openDirectory:');
    expect(preload).not.toContain('showOpenDialog');
    expect(mainIpc).toContain('dialog.showOpenDialog');
    expect(mainIpc).toContain("properties: ['openDirectory']");
    expect(html).toContain("connect-src 'self'");
  });

  it('requires an authorized workspace identity for file and terminal capabilities', async () => {
    const contract = await readFile(join(process.cwd(), 'src', 'shared', 'contract.ts'), 'utf8');
    const workspaceService = await readFile(join(process.cwd(), 'src', 'main', 'services', 'workspace-file-service.ts'), 'utf8');
    const fileExplorer = await readFile(join(process.cwd(), 'src', 'renderer', 'src', 'modules', 'file-explorer', 'FileExplorerPanel.tsx'), 'utf8');
    const terminal = await readFile(join(process.cwd(), 'src', 'renderer', 'src', 'modules', 'terminal', 'TerminalPanel.tsx'), 'utf8');

    expect(contract).toMatch(/interface CreateTerminalSessionRequest[\s\S]*?workspaceId: string;/);
    expect(contract).toMatch(/interface WorkspaceDirectoryRequest[\s\S]*?workspaceId: string;/);
    expect(workspaceService).toContain('private requireWorkspace(workspaceId: string)');
    expect(fileExplorer).toContain('onSelectedWorkspaceChanged(setWorkspaceId)');
    expect(fileExplorer).toContain('workspaceId: requestedWorkspaceId');
    expect(terminal).toContain('[activeShell]: selectedWorkspaceId');
    expect(terminal).toContain('workspaceId,');
    expect(terminal).toContain('workspaceId={workspaceId}');
  });

  it('allows native popouts without opening an unrestricted browser surface', async () => {
    const mainWindow = await readFile(join(process.cwd(), 'src', 'main', 'windows', 'main-window.ts'), 'utf8');
    const workspace = await readFile(join(process.cwd(), 'src', 'renderer', 'src', 'app', 'Workspace.tsx'), 'utf8');
    const moduleTab = await readFile(join(process.cwd(), 'src', 'renderer', 'src', 'app', 'ModuleTab.tsx'), 'utf8');

    expect(mainWindow).toContain('isTrustedDockviewPopoutUrl');
    expect(mainWindow).toMatch(/setWindowOpenHandler[\s\S]*?action: 'deny'/);
    expect(workspace).toContain('popoutUrl={DOCKVIEW_POPOUT_PATH}');
    expect(workspace).toContain('onDragEnd={popoutWhenDroppedOutside}');
    expect(moduleTab).toContain('containerApi.addPopoutGroup(panel)');

    const mainIpc = await readFile(join(process.cwd(), 'src', 'main', 'ipc', 'register-ipc.ts'), 'utf8');
    expect(mainIpc).toContain('getPrivilegedRendererContents');
    expect(mainWindow).toContain('this.popoutWindows.add(child)');
    expect(mainWindow).toMatch(/const popoutWebPreferences: WebPreferences = \{[\s\S]*?sandbox: true,[\s\S]*?nodeIntegration: false/);
    expect(mainWindow).not.toMatch(/const popoutWebPreferences: WebPreferences = \{[\s\S]*?preload,/);
    expect(mainWindow).toMatch(/getPrivilegedRendererContents\(\): WebContents\[\] \{[\s\S]*?this\.window\?\.webContents/);
    expect(mainWindow).not.toMatch(/getPrivilegedRendererContents\(\): WebContents\[\] \{[^}]*popoutWindows/);
  });

  it('turns top-level startup failures into a controlled application exit', async () => {
    const main = await readFile(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8');
    expect(main).toContain("console.error('Application startup failed.'");
    expect(main).toMatch(/app\.whenReady\(\)[\s\S]*?\.catch\([\s\S]*?process\.exitCode = 1;[\s\S]*?app\.quit\(\)/);

    const application = await readFile(join(process.cwd(), 'src', 'main', 'application.ts'), 'utf8');
    expect(application).toContain('await this.mainWindow.waitUntilRendererLoaded();');
  });
});

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

describe('clean desktop shell boundary', () => {
  it('contains no Runtime, Agent backend, local HTTP Server, or child-process implementation', async () => {
    const files = await collectSourceFiles(join(process.cwd(), 'src'));
    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (/(@ariadne\/protocol|AgentRelay|agent-service|child_process|node:child_process|createServer\s*\(|\.listen\s*\(|ariadne:runtime:)/.test(source)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps every desktop module registered without adding a Runtime service dependency', async () => {
    const registry = await readFile(join(process.cwd(), 'src', 'renderer', 'src', 'core', 'modules', 'builtin-modules.ts'), 'utf8');
    for (const moduleName of [
      'chatModule',
      'conversationsModule',
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

    const contract = await readFile(join(process.cwd(), 'src', 'renderer', 'src', 'core', 'modules', 'module-contract.ts'), 'utf8');
    expect(contract).not.toMatch(/runtime:|agent:/i);
  });

  it('keeps Renderer isolated behind the fixed Preload bridge', async () => {
    const preload = await readFile(join(process.cwd(), 'src', 'preload', 'index.ts'), 'utf8');
    const html = await readFile(join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
    expect(preload).not.toMatch(/\bfetch\s*\(|\b(?:baseUrl|port|token)\b/i);
    expect(html).toContain("connect-src 'self'");
  });
});

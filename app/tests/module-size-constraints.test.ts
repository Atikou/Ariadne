import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = join(process.cwd(), 'src', 'renderer', 'src');

describe('Dockview module size constraints', () => {
  it('requires every registered module to declare a useful minimum width', async () => {
    const modulesRoot = join(rendererRoot, 'modules');
    const directories = await readdir(modulesRoot, { withFileTypes: true });
    const definitions = await Promise.all(directories
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const file = join(modulesRoot, entry.name, 'index.ts');
        return { name: entry.name, source: await readFile(file, 'utf8') };
      }));

    expect(definitions).toHaveLength(9);
    for (const definition of definitions) {
      const minimumWidth = Number(definition.source.match(/layoutConstraints:\s*\{\s*minimumWidth:\s*(\d+)/)?.[1]);
      expect(minimumWidth, definition.name).toBeGreaterThanOrEqual(200);
    }
    const settings = definitions.find((definition) => definition.name === 'settings');
    expect(settings?.source).toContain('minimumWidth: 340');
    const chat = definitions.find((definition) => definition.name === 'chat');
    expect(chat?.source).toContain('minimumWidth: 620');
  });

  it('applies current constraints to new panels and restored layouts', async () => {
    const contract = await readFile(join(rendererRoot, 'core', 'modules', 'module-contract.ts'), 'utf8');
    const workspace = await readFile(join(rendererRoot, 'app', 'Workspace.tsx'), 'utf8');

    expect(contract).toContain('layoutConstraints: ModuleLayoutConstraints;');
    expect(workspace).toContain('minimumWidth: definition.layoutConstraints.minimumWidth');
    expect(workspace).toMatch(/api\.fromJSON\(layout\);\s*applyModuleConstraints\(api, registry\);/);
    expect(workspace).toMatch(/function applyModuleConstraints[\s\S]*?api\.setConstraints\(\{[\s\S]*?minimumWidth:/);
  });
});

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyThemeToDocument,
  resolveEffectiveTheme,
  type ThemeDocument
} from '../src/renderer/src/app/theme-sync';

describe('Dockview popout theme synchronization', () => {
  it('resolves explicit and system theme preferences', () => {
    expect(resolveEffectiveTheme('light', true)).toBe('light');
    expect(resolveEffectiveTheme('dark', false)).toBe('dark');
    expect(resolveEffectiveTheme('system', true)).toBe('dark');
    expect(resolveEffectiveTheme('system', false)).toBe('light');
  });

  it('applies the same theme and color scheme to another document', () => {
    const target: ThemeDocument = {
      documentElement: { dataset: {}, style: { colorScheme: '' } }
    };
    applyThemeToDocument(target, 'light');
    expect(target.documentElement.dataset.theme).toBe('light');
    expect(target.documentElement.style.colorScheme).toBe('light');
  });

  it('syncs newly-created and already-open popout windows from Workspace', async () => {
    const app = await readFile(join(process.cwd(), 'src', 'renderer', 'src', 'app', 'App.tsx'), 'utf8');
    const workspace = await readFile(join(process.cwd(), 'src', 'renderer', 'src', 'app', 'Workspace.tsx'), 'utf8');

    expect(app).toContain('effectiveTheme={effectiveTheme}');
    expect(workspace).toContain('api.onDidAddPopoutGroup');
    expect(workspace).toContain('api.getPopouts()');
    expect(workspace).toContain('applyThemeToWindow(popout.window, effectiveTheme)');
  });
});

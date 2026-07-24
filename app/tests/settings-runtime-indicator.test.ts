import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('settings runtime indicator', () => {
  it('uses the animated sweep while Runtime starts or restarts', async () => {
    const panel = await readFile(join(process.cwd(), 'src', 'renderer', 'src', 'modules', 'settings', 'SettingsPanel.tsx'), 'utf8');
    const styles = await readFile(join(process.cwd(), 'src', 'renderer', 'src', 'app', 'styles.css'), 'utf8');

    expect(panel).toMatch(/availability === 'starting' \|\| runtime\.status\.availability === 'restarting'/);
    expect(panel).toContain('settings-runtime-indicator--${runtimeStateTone}');
    expect(styles).toMatch(/\.settings-runtime-indicator--loading\s*\{[^}]*settings-runtime-sweep \.8s infinite linear alternate[^}]*settings-runtime-turn 1\.6s infinite linear/);
    expect(styles).toContain('@keyframes settings-runtime-sweep');
    expect(styles).toContain('@keyframes settings-runtime-turn');
  });

  it('replaces the loader with a completed check when Runtime is ready', async () => {
    const panel = await readFile(join(process.cwd(), 'src', 'renderer', 'src', 'modules', 'settings', 'SettingsPanel.tsx'), 'utf8');
    const styles = await readFile(join(process.cwd(), 'src', 'renderer', 'src', 'app', 'styles.css'), 'utf8');

    expect(panel).toMatch(/availability === 'ready'[\s\S]*?\? '✓'/);
    expect(styles).toMatch(/\.settings-runtime-indicator\s*\{[^}]*border-radius:\s*50%/);
    expect(styles).toMatch(/\.settings-runtime-indicator--ready\s*\{[^}]*background:\s*var\(--success\)/);
    expect(panel).toContain('role="status" aria-live="polite"');
  });
});

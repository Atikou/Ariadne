import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('settings panel responsive layout', () => {
  it('responds to the Dockview panel width without fixed grid minimums', async () => {
    const styles = await readFile(join(process.cwd(), 'src', 'renderer', 'src', 'app', 'styles.css'), 'utf8');

    expect(styles).toMatch(/\.settings-panel\s*\{[^}]*container:\s*settings-panel\s*\/\s*inline-size;/);
    expect(styles).toMatch(/@container\s+settings-panel\s*\(max-width:\s*440px\)/);
    expect(styles).toMatch(/@container\s+settings-panel\s*\(max-width:\s*260px\)/);
    expect(styles).toMatch(/\.agent-settings-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*\.7fr\)\s+minmax\(0,\s*1\.3fr\)/);
    expect(styles).not.toMatch(/\.agent-settings-grid\s*\{[^}]*minmax\((?:120|190)px/);
    expect(styles).toMatch(/@container[\s\S]*?\.agent-settings-grid\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(styles).toMatch(/@container[\s\S]*?\.settings-section-title\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(styles).toMatch(/\.settings-section-heading h2\s*\{\s*word-break:\s*keep-all;/);
  });
});

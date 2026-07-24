import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = join(process.cwd(), 'src', 'renderer', 'src');

describe('remote provider settings disclosure', () => {
  it('starts each provider collapsed and keeps only its name and enabled checkbox in the legend', async () => {
    const panel = await readFile(join(rendererRoot, 'modules', 'settings', 'SettingsPanel.tsx'), 'utf8');
    const legend = panel.match(/<legend>[\s\S]*?<\/legend>/)?.[0] ?? '';

    expect(panel).toContain('const initialProviderExpansion');
    expect(panel).toContain('aria-expanded={expanded}');
    expect(panel).toContain('aria-controls={detailsId}');
    expect(panel).toContain('hidden={!expanded}');
    expect(legend).toContain('<span>{label}</span>');
    expect(legend).toContain('className="provider-enable"');
    expect(legend).not.toContain('provider-health');
    expect(legend).not.toContain('type="password"');
  });

  it('uses the shared project styling instead of a native details disclosure', async () => {
    const panel = await readFile(join(rendererRoot, 'modules', 'settings', 'SettingsPanel.tsx'), 'utf8');
    const styles = await readFile(join(rendererRoot, 'app', 'styles.css'), 'utf8');

    expect(panel).toContain('className="provider-disclosure"');
    expect(panel).not.toContain('<details');
    expect(styles).toMatch(/\.provider-disclosure\s*\{/);
    expect(styles).toMatch(/\.provider-settings-body\[hidden\]\s*\{\s*display:\s*none;/);
  });
});

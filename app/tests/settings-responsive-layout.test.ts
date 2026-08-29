import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('settings panel responsive layout', () => {
  it('uses a modal settings center with fixed navigation and independently scrolling content', async () => {
    const [app, dialog, panel, styles] = await Promise.all([
      readFile(join(process.cwd(), 'src', 'renderer', 'src', 'app', 'App.tsx'), 'utf8'),
      readFile(join(process.cwd(), 'src', 'renderer', 'src', 'modules', 'settings', 'SettingsDialog.tsx'), 'utf8'),
      readFile(join(process.cwd(), 'src', 'renderer', 'src', 'modules', 'settings', 'SettingsPanel.tsx'), 'utf8'),
      readFile(join(process.cwd(), 'src', 'renderer', 'src', 'app', 'styles.css'), 'utf8')
    ]);

    expect(app).toContain('id === MODULE_IDS.settings');
    expect(app).toContain('<SettingsDialog open={settingsOpen}');
    expect(dialog).toContain('role="dialog"');
    expect(dialog).toContain('aria-modal="true"');
    expect(dialog).toContain("appShell?.setAttribute('inert', '')");
    expect(dialog).toContain("event.key === 'Escape'");
    expect(panel).toContain('className="settings-navigation"');
    expect(panel).toContain("activeCategory === 'speech'");
    expect(panel).toContain("activeCategory === 'chat'");
    expect(panel).toContain('id={`${moduleId}-agent-settings-form`}');
    expect(panel).toContain('id={`${moduleId}-chat-settings-form`}');
    expect(panel).toContain("kind: 'assistant.replace'");
    expect(panel).toContain('助手人设 / 回答风格');
    expect(panel).toContain('用户人设（可选）');
    expect(panel).not.toContain('启用无限制模式');
    expect(panel).toContain('className="settings-field settings-select-field"');
    expect(panel).not.toMatch(/<label className="settings-field[^\"]*"><span>[^<]+<\/span><SelectMenu/);
    expect(panel).toContain('className="agent-settings-actions settings-floating-actions"');
    expect(styles).toMatch(/\.settings-panel\s*\{[^}]*container:\s*settings-panel\s*\/\s*inline-size;/);
    expect(styles).toMatch(/\.settings-panel\s*\{[^}]*grid-template-columns:\s*210px minmax\(0,\s*1fr\)/);
    expect(styles).toMatch(/\.settings-content-scroll\s*\{[^}]*overflow-y:\s*auto;/);
    expect(styles).toMatch(/\.settings-content--with-actions \.settings-content-scroll\s*\{[^}]*padding-bottom:\s*96px;/);
    expect(styles).toMatch(/\.settings-floating-actions\s*\{[^}]*position:\s*absolute;[^}]*right:\s*28px;[^}]*bottom:\s*22px;/);
    const floatingSurface = styles.match(/\.settings-floating-actions\s*\{[^}]*\}/)?.[0] ?? '';
    expect(floatingSurface).not.toMatch(/(?:background|border|box-shadow|padding):/);
    expect(styles).toMatch(/\.settings-floating-actions \.primary-button\s*\{[^}]*box-shadow:[^}]*inset 0 1px 0[^}]*transform:\s*translateY\(0\)/);
    expect(styles).toMatch(/\.settings-floating-actions \.primary-button:hover:not\(:disabled\)\s*\{[^}]*transform:\s*translateY\(-1px\)/);
    expect(styles).toMatch(/\.primary-button, \.secondary-button, \.ghost-button\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*gap:\s*6px;[^}]*line-height:\s*1;/);
    expect(styles).toMatch(/\.primary-button > svg, \.secondary-button > svg, \.ghost-button > svg\s*\{[^}]*display:\s*block;[^}]*flex:\s*0 0 auto;/);
    expect(styles).toMatch(/\.settings-section-copy p\s*\{[^}]*font-size:\s*10px;[^}]*line-height:\s*1\.5;/);
    expect(styles).toMatch(/@container\s+settings-panel\s*\(max-width:\s*760px\)/);
    expect(styles).toMatch(/@container\s+settings-panel\s*\(max-width:\s*540px\)/);
    expect(styles).toMatch(/\.agent-settings-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*\.7fr\)\s+minmax\(0,\s*1\.3fr\)/);
    expect(styles).not.toMatch(/\.agent-settings-grid\s*\{[^}]*minmax\((?:120|190)px/);
    expect(styles).toMatch(/@container[\s\S]*?\.agent-settings-grid\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(styles).toMatch(/\.settings-section-heading h2\s*\{\s*word-break:\s*keep-all;/);
    expect(styles).toMatch(/\.settings-select-menu \.select-menu-trigger\s*\{[^}]*width:\s*100%;[^}]*height:\s*36px;[^}]*border-color:\s*var\(--border-strong\);/);
  });
});

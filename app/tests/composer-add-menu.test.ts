import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = join(process.cwd(), 'src', 'renderer', 'src');

describe('Composer add menu', () => {
  it('places a plus trigger before the model selector and opens a portal above the composer', async () => {
    const [chat, menu, styles] = await Promise.all([
      readFile(join(rendererRoot, 'modules', 'chat', 'ChatPanel.tsx'), 'utf8'),
      readFile(join(rendererRoot, 'modules', 'chat', 'ComposerAddMenu.tsx'), 'utf8'),
      readFile(join(rendererRoot, 'app', 'styles.css'), 'utf8')
    ]);

    expect(chat).toMatch(
      /<div className="composer-model-controls">\s*<ComposerAddMenu[\s\S]*?planModeAvailable=\{planModeAvailable\}[\s\S]*?planModeEnabled=\{planModeEnabled\}[\s\S]*?\/>\s*<SelectMenu<string>/
    );
    expect(menu).toContain('<Plus size={18}');
    expect(menu).toContain('aria-haspopup="menu"');
    expect(menu).toContain('createPortal(popover, document.body)');
    expect(menu).toContain("bottom: Math.max(10, window.innerHeight - bounds.top + 8)");
    expect(styles).toMatch(/\.composer-add-popover\s*\{[^}]*position:\s*fixed;[^}]*overflow-y:\s*auto;/);
  });

  it('wires only Plan mode while keeping the other requested rows presentation-only', async () => {
    const menu = await readFile(
      join(rendererRoot, 'modules', 'chat', 'ComposerAddMenu.tsx'),
      'utf8'
    );

    for (const expectedText of [
      '文件和文件夹',
      '设置要持续追求的目标',
      '开启计划模式',
      'Documents',
      'PDF',
      'Spreadsheets',
      'Presentations',
      'Template Creator',
      'Sites'
    ]) {
      expect(menu).toContain(expectedText);
    }
    expect(menu).toContain("if (item.id !== 'plan' || item.disabled) return");
    expect(menu).toContain('onPlanModeChange(!planModeEnabled)');
    expect(menu).toContain('aria-pressed');
    expect(menu).toContain('disabled={item.disabled}');
    expect(menu).toContain('composer-plan-mode-chip');
    expect(menu).not.toContain('services.');
    expect(menu).not.toContain('window.ariadne');
  });
});

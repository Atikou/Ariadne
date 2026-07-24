import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createEditableLocalModelRoots,
  moveLocalModelRoot,
  normalizeLocalModelRoots
} from '../src/renderer/src/modules/settings/local-model-roots';

describe('local model root list', () => {
  it('keeps one editable row when no directory is configured', () => {
    expect(createEditableLocalModelRoots([])).toEqual(['']);
    expect(createEditableLocalModelRoots(['D:\\Models'])).toEqual(['D:\\Models']);
  });

  it('normalizes the editable rows before saving', () => {
    expect(normalizeLocalModelRoots([' D:\\Models ', '', ' E:\\GGUF ']))
      .toEqual(['D:\\Models', 'E:\\GGUF']);
  });

  it('moves a directory to the dropped position without changing the other values', () => {
    expect(moveLocalModelRoot(['A', 'B', 'C'], 0, 2)).toEqual(['B', 'C', 'A']);
    expect(moveLocalModelRoot(['A', 'B', 'C'], 2, 0)).toEqual(['C', 'A', 'B']);
  });

  it('ignores invalid and no-op moves', () => {
    expect(moveLocalModelRoot(['A', 'B'], 1, 1)).toEqual(['A', 'B']);
    expect(moveLocalModelRoot(['A', 'B'], -1, 1)).toEqual(['A', 'B']);
    expect(moveLocalModelRoot(['A', 'B'], 0, 4)).toEqual(['A', 'B']);
  });

  it('uses a compact shared list frame instead of separate input cards', async () => {
    const panel = await readFile(join(process.cwd(), 'src', 'renderer', 'src', 'modules', 'settings', 'SettingsPanel.tsx'), 'utf8');
    const styles = await readFile(join(process.cwd(), 'src', 'renderer', 'src', 'app', 'styles.css'), 'utf8');

    expect(panel).toMatch(/local-model-roots-control[\s\S]*local-model-roots-list[\s\S]*local-model-root-add/);
    expect(styles).toMatch(/\.local-model-roots-control\s*\{[^}]*overflow:\s*hidden;[^}]*border:\s*1px solid/);
    expect(styles).toMatch(/\.local-model-root-row\s*\{[^}]*height:\s*26px;[^}]*grid-template-columns:\s*22px minmax\(0,\s*1fr\) 24px/);
    expect(styles).toMatch(/\.settings-field \.local-model-root-input\s*\{[^}]*height:\s*26px;[^}]*font-size:\s*10px/);
    expect(styles).toMatch(/\.local-model-root-add\s*\{[^}]*height:\s*24px;[^}]*border-top:\s*1px solid/);
    expect(styles).not.toMatch(/\.local-model-root-add\s*\{[^}]*border:\s*1px dashed/);
  });
});

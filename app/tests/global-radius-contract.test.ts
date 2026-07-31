import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const stylesPath = join(process.cwd(), 'src', 'renderer', 'src', 'app', 'styles.css');

describe('global radius contract', () => {
  it('uses fixed 12px, 16px, and 20px tokens for every non-circular rounded component', async () => {
    const styles = await readFile(stylesPath, 'utf8');
    const radiusValues = [...styles.matchAll(/border-radius\s*:\s*([^;]+);/g)]
      .map((match) => (match[1] ?? '').trim());
    const validTokenPattern = /^(?:0|var\(--radius-(?:sm|md|lg)\))(?:\s+(?:0|var\(--radius-(?:sm|md|lg)\))){0,3}$/;
    const unexpectedValues = radiusValues.filter((value) =>
      value !== '50%' && !validTokenPattern.test(value)
    );

    expect(styles).toContain('--radius-sm: 12px;');
    expect(styles).toContain('--radius-md: 16px;');
    expect(styles).toContain('--radius-lg: 20px;');
    expect(unexpectedValues).toEqual([]);
  });

  it('keeps the native main window outside the component radius contract', async () => {
    const styles = await readFile(stylesPath, 'utf8');

    expect(styles).toMatch(/\.app-shell\s*\{[^}]*background:\s*var\(--bg-0\);[^}]*\}/);
    expect(styles).not.toMatch(/\.app-shell\s*\{[^}]*border-radius:/);
  });
});

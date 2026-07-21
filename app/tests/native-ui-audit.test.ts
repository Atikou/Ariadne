import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  }));
  return nested.flat();
}

describe('renderer native UI audit', () => {
  it('does not expose browser-native selects or blocking dialogs', async () => {
    const files = await collectSourceFiles(join(process.cwd(), 'src', 'renderer', 'src'));
    const forbidden = /<select\b|<option\b|window\.(?:alert|confirm|prompt)\b/;
    const offenders: string[] = [];

    for (const file of files) {
      if (forbidden.test(await readFile(file, 'utf8'))) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });

  it('does not bypass the typed preload bridge for clipboard access', async () => {
    const files = await collectSourceFiles(join(process.cwd(), 'src', 'renderer', 'src'));
    const offenders: string[] = [];

    for (const file of files) {
      if (/navigator\.clipboard\b/.test(await readFile(file, 'utf8'))) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });
});

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

async function collectRendererSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectRendererSources(path);
    return /\.(?:css|tsx?)$/.test(entry.name) ? [path] : [];
  }));
  return nested.flat();
}

describe('renderer theme consistency', () => {
  it('does not hard-code a light-colored component background outside theme tokens', async () => {
    const files = await collectRendererSources(join(process.cwd(), 'src', 'renderer', 'src'));
    const hardCodedLightSurface = /(?:background(?:-color)?|backgroundColor)\s*:\s*['"]?(?:white\b|#f(?:[0-9a-f]{2}){1,2}\b)/i;
    const offenders: string[] = [];

    for (const file of files) {
      if (hardCodedLightSurface.test(await readFile(file, 'utf8'))) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });
});

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StateRepository } from '../src/main/persistence/state-repository';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    if (!directory.startsWith(tmpdir())) throw new Error('Refusing to clean a non-temporary test directory.');
    await rm(directory, { recursive: true, force: true });
  }
});

describe('StateRepository', () => {
  it('atomically persists and reloads a versioned layout', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-state-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'state.json');
    const first = new StateRepository(file);
    await first.initialize();
    await first.saveLayout({
      schemaVersion: 1,
      layout: { panels: { 'files.explorer': { component: 'files.explorer' } } },
      savedAt: '2026-07-17T00:00:00.000Z'
    });

    const second = new StateRepository(file);
    await second.initialize();

    expect(second.getLayout()?.layout).toEqual({
      panels: { 'files.explorer': { component: 'files.explorer' } }
    });
    expect(JSON.parse(await readFile(file, 'utf8')).schemaVersion).toBe(1);
  });
});

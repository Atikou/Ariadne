import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('keeps memory committed to disk state and recovers after a failed write', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-state-recovery-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'state.json');
    const repository = new StateRepository(file);
    await repository.initialize();
    const initial = repository.getPreferences();
    const changed = {
      ...initial,
      theme: initial.theme === 'dark' ? 'light' as const : 'dark' as const
    };

    await mkdir(file);
    await expect(repository.savePreferences(changed)).rejects.toBeInstanceOf(Error);
    expect(repository.getPreferences()).toEqual(initial);

    await rm(file, { recursive: true });
    await repository.savePreferences(changed);

    expect(repository.getPreferences()).toEqual(changed);
    expect(JSON.parse(await readFile(file, 'utf8')).preferences).toEqual(changed);
  });

  it('does not classify a state read failure as corrupt content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-state-read-failure-'));
    temporaryDirectories.push(directory);
    const statePath = join(directory, 'state.json');
    await mkdir(statePath);
    await writeFile(join(statePath, 'keep.txt'), 'keep');

    await expect(new StateRepository(statePath).initialize()).rejects.toBeInstanceOf(Error);

    expect(await readFile(join(statePath, 'keep.txt'), 'utf8')).toBe('keep');
    expect((await readdir(directory)).filter((name) => name.startsWith('state.json.invalid-'))).toEqual([]);
  });

  it('fails closed when invalid state cannot be preserved before recovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-state-backup-failure-'));
    temporaryDirectories.push(directory);
    const statePath = join(directory, 'state.json');
    await writeFile(statePath, '{ invalid json');
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_234_567_890);
    await mkdir(`${statePath}.invalid-1234567890`);

    try {
      await expect(new StateRepository(statePath).initialize()).rejects.toThrow(
        'Unable to preserve invalid application state before recovery.'
      );
    } finally {
      now.mockRestore();
    }

    expect(await readFile(statePath, 'utf8')).toBe('{ invalid json');
  });
});

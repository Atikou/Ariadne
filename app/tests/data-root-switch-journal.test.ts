import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { archiveSettledDataRootSwitch, dataRootCandidateName, inspectDataRootSwitch,
  prepareDataRootSwitch, settleDataRootSwitch } from '../src/main/data-management/data-root-switch-journal';

const roots: string[] = [];
afterEach(async () => {
  const temp = await realpath(tmpdir());
  for (const root of roots.splice(0)) {
    if (dirname(root) !== temp || !basename(root).startsWith('AriadneRootSwitch-') || await realpath(root) !== root)
      throw new Error('Unsafe fixture cleanup.');
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'AriadneRootSwitch-'))); roots.push(parent);
  const dataRoot = join(parent, 'profile'), operationId = randomUUID(), backupId = randomUUID();
  const candidate = join(parent, dataRootCandidateName('profile', operationId));
  const retained = join(parent, '.profile.ariadne-retained-' + operationId);
  const journal = join(parent, '.profile.ariadne-restore-journal.json');
  await mkdir(dataRoot); await mkdir(candidate);
  await writeFile(join(dataRoot, 'original.txt'), 'original protected fixture');
  await writeFile(join(candidate, 'replacement.txt'), 'replacement protected fixture');
  await prepareDataRootSwitch({ dataRoot, operationId, backupId, inventorySha256: 'a'.repeat(64) });
  return { parent, dataRoot, candidate, retained, journal };
}
const interrupted = async () => { throw new Error('Injected interruption.'); };

describe('recoverable same-volume root switch', () => {
  it('installs the replacement, retains the complete original and archives only a settled record', async () => {
    const f = await fixture();
    await expect(archiveSettledDataRootSwitch(f.dataRoot)).rejects.toThrow('unsettled');
    await settleDataRootSwitch(f.dataRoot, 'replacement');
    expect((await inspectDataRootSwitch(f.dataRoot))?.current).toBe('replacement');
    expect(await readFile(join(f.retained, 'original.txt'), 'utf8')).toBe('original protected fixture');
    expect(await readFile(join(f.dataRoot, 'replacement.txt'), 'utf8')).toBe('replacement protected fixture');
    await archiveSettledDataRootSwitch(f.dataRoot);
    expect(await inspectDataRootSwitch(f.dataRoot)).toBeNull();
    expect(await readFile(join(f.retained, 'original.txt'), 'utf8')).toBe('original protected fixture');
  });
  it.each(['original-retained', 'replacement-installed'] as const)('offers either root after interruption at %s', async phase => {
    const f = await fixture();
    await expect(settleDataRootSwitch(f.dataRoot, 'replacement', async current => {
      if (current === phase) await interrupted();
    })).rejects.toThrow('Injected interruption');
    expect((await inspectDataRootSwitch(f.dataRoot))?.choices).toEqual(['original', 'replacement']);
    await settleDataRootSwitch(f.dataRoot, 'original');
    expect((await inspectDataRootSwitch(f.dataRoot))?.current).toBe('original');
    expect(await readFile(join(f.dataRoot, 'original.txt'), 'utf8')).toBe('original protected fixture');
    expect(await readFile(join(f.candidate, 'replacement.txt'), 'utf8')).toBe('replacement protected fixture');
  });
  it.each(['retain', 'install'] as const)('recovers a crash after %s rename but before the journal write', async boundary => {
    const f = await fixture();
    await rename(f.dataRoot, f.retained);
    if (boundary === 'install') await rename(f.candidate, f.dataRoot);
    expect((await inspectDataRootSwitch(f.dataRoot))?.journal.phase).toBe('prepared');
    await settleDataRootSwitch(f.dataRoot, 'replacement');
    expect((await inspectDataRootSwitch(f.dataRoot))?.current).toBe('replacement');
    expect(await readFile(join(f.retained, 'original.txt'), 'utf8')).toBe('original protected fixture');
  });
  it('recovers an interrupted rollback without removing either directory', async () => {
    const f = await fixture(); await settleDataRootSwitch(f.dataRoot, 'replacement');
    await expect(settleDataRootSwitch(f.dataRoot, 'original', interrupted)).rejects.toThrow('Injected interruption');
    expect((await inspectDataRootSwitch(f.dataRoot))?.current).toBe('absent');
    await settleDataRootSwitch(f.dataRoot, 'original');
    expect(await readFile(join(f.dataRoot, 'original.txt'), 'utf8')).toBe('original protected fixture');
    expect(await readFile(join(f.candidate, 'replacement.txt'), 'utf8')).toBe('replacement protected fixture');
  });
  it('rejects a root recreated by another process without touching any data', async () => {
    const f = await fixture(); await rename(f.dataRoot, f.retained); await mkdir(f.dataRoot);
    await writeFile(join(f.dataRoot, 'unexpected.txt'), 'external data');
    await expect(settleDataRootSwitch(f.dataRoot, 'replacement')).rejects.toThrow('restore_current_root_changed');
    expect(await readFile(join(f.dataRoot, 'unexpected.txt'), 'utf8')).toBe('external data');
    expect(await readFile(join(f.retained, 'original.txt'), 'utf8')).toBe('original protected fixture');
  });
  it('rejects corrupted, oversized, or redirected journal identities', async () => {
    const f = await fixture(), original = await readFile(f.journal, 'utf8');
    await writeFile(f.journal, original.replace('"rootName":"profile"', '"rootName":"../outside"'));
    await expect(inspectDataRootSwitch(f.dataRoot)).rejects.toThrow();
    await writeFile(f.journal, ' '.repeat(8193));
    await expect(inspectDataRootSwitch(f.dataRoot)).rejects.toThrow('restore_journal_invalid');
    expect(await readFile(join(f.dataRoot, 'original.txt'), 'utf8')).toBe('original protected fixture');
  });
  it('does not replace an existing pending record or retained directory', async () => {
    const f = await fixture(), original = await readFile(f.journal, 'utf8');
    const operationId = randomUUID(), candidate = join(f.parent, dataRootCandidateName('profile', operationId));
    await mkdir(candidate);
    await expect(prepareDataRootSwitch({ dataRoot: f.dataRoot, operationId, backupId: randomUUID(), inventorySha256: 'a'.repeat(64) })).rejects.toThrow();
    expect(await readFile(f.journal, 'utf8')).toBe(original);
  });
});

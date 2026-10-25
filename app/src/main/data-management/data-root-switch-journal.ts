import { randomUUID } from 'node:crypto';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';

const rootName = z.string().min(1).max(100).regex(/^[^\\/:*?"<>|\x00-\x1f]+$/u)
  .refine(value => value !== '.' && value !== '..' && !/[. ]$/u.test(value));
const identity = z.object({ device: z.string().regex(/^\d+$/u), inode: z.string().regex(/^[1-9]\d*$/u) }).strict();
const journalSchema = z.object({ format: z.literal('ariadne.data-root-switch'), version: z.literal(1),
  operationId: z.uuid(), backupId: z.uuid(), inventorySha256: z.string().regex(/^[a-f0-9]{64}$/u), rootName, original: identity, replacement: identity,
  phase: z.enum(['prepared', 'original-retained', 'replacement-installed', 'committed', 'rolled-back']),
  preparedAt: z.iso.datetime() }).strict();
export type DataRootSwitchJournal = z.infer<typeof journalSchema>;
export type DataRootRecoveryChoice = 'original' | 'replacement';
type RootIdentity = z.infer<typeof identity>;
export interface DataRootSwitchInspection {
  journal: DataRootSwitchJournal;
  current: 'original' | 'replacement' | 'absent';
  choices: readonly DataRootRecoveryChoice[];
}
interface OwnedSwitchPaths { parent: string; journal: string; current: string; candidate: string; retained: string }

/** No directory is removed, merged, or overwritten. All three roots are exact
 * siblings identified before admission. Call only after the original process
 * and all its data owners have actually exited. Startup must inspect unfinished
 * journals before constructing persistence owners or starting Actors. */
export async function prepareDataRootSwitch(input: { dataRoot: string; operationId: string; backupId: string; inventorySha256: string }): Promise<DataRootSwitchJournal> {
  if (!isAbsolute(input.dataRoot)) throw new Error('restore_root_invalid');
  const name = rootName.parse(basename(input.dataRoot));
  const parent = await canonicalDirectory(dirname(input.dataRoot));
  const operationId = z.uuid().parse(input.operationId), backupId = z.uuid().parse(input.backupId);
  const paths = switchPaths(parent, name, operationId);
  if (await pathIdentity(paths.retained)) throw new Error('restore_retained_root_exists');
  const original = await pathIdentity(paths.current), replacement = await pathIdentity(paths.candidate);
  if (!original || !replacement || original.device !== replacement.device || sameIdentity(original, replacement)) throw new Error('restore_root_identity_invalid');
  const journal = journalSchema.parse({ format: 'ariadne.data-root-switch', version: 1, operationId, backupId,
    inventorySha256: input.inventorySha256, rootName: name, original, replacement, phase: 'prepared', preparedAt: new Date().toISOString() });
  await writeExclusiveSynced(paths.journal, Buffer.from(JSON.stringify(journal) + '\n'));
  return journal;
}

export function dataRootCandidateName(name: string, operationId: string): string {
  return '.' + rootName.parse(name) + '.ariadne-candidate-' + z.uuid().parse(operationId);
}

/** Filesystem identities, rather than the last journal phase, decide which
 * operation completed: a crash can occur after rename and before phase fsync. */
export async function inspectDataRootSwitch(dataRoot: string): Promise<DataRootSwitchInspection | null> {
  const loaded = await loadSwitch(dataRoot);
  if (!loaded) return null;
  return inspectOwnedSwitch(loaded.paths, loaded.journal);
}

export async function settleDataRootSwitch(dataRoot: string, choice: DataRootRecoveryChoice,
  afterBoundary?: (phase: DataRootSwitchJournal['phase']) => Promise<void>): Promise<DataRootSwitchJournal> {
  const loaded = await loadSwitch(dataRoot);
  if (!loaded) throw new Error('restore_journal_missing');
  const { paths } = loaded;
  let journal = loaded.journal;
  const inspected = await inspectOwnedSwitch(paths, journal);
  if (!inspected.choices.includes(choice)) throw new Error('restore_choice_unavailable');
  const checkpoint = async (phase: DataRootSwitchJournal['phase']) => {
    journal = { ...journal, phase };
    await replaceJournal(paths, journal);
    await afterBoundary?.(phase);
  };
  if (choice === 'replacement') {
    if (inspected.current === 'original') {
      await renameOwned(paths.current, paths.retained, journal.original);
      await checkpoint('original-retained');
    }
    if (inspected.current !== 'replacement') {
      await renameOwned(paths.candidate, paths.current, journal.replacement);
      await checkpoint('replacement-installed');
    }
    await checkpoint('committed');
  } else {
    if (inspected.current === 'replacement') {
      await renameOwned(paths.current, paths.candidate, journal.replacement);
      // The same structural state as a crash after retaining the original.
      await checkpoint('original-retained');
    }
    if (inspected.current !== 'original') await renameOwned(paths.retained, paths.current, journal.original);
    await checkpoint('rolled-back');
  }
  return journal;
}

/** Archive only a settled record whose root still has the recorded identity.
 * The original retained directory remains available; it is never auto-cleaned. */
export async function archiveSettledDataRootSwitch(dataRoot: string): Promise<void> {
  const loaded = await loadSwitch(dataRoot);
  if (!loaded) return;
  const state = await inspectOwnedSwitch(loaded.paths, loaded.journal);
  if (!(state.journal.phase === 'committed' && state.current === 'replacement')
    && !(state.journal.phase === 'rolled-back' && state.current === 'original')) throw new Error('restore_journal_unsettled');
  const archived = loaded.paths.journal + '.' + state.journal.operationId + '.settled';
  if (await exists(archived)) throw new Error('restore_journal_archive_exists');
  await rename(loaded.paths.journal, archived);
}

async function inspectOwnedSwitch(paths: OwnedSwitchPaths, journal: DataRootSwitchJournal): Promise<DataRootSwitchInspection> {
  const current = await pathIdentity(paths.current), candidate = await pathIdentity(paths.candidate), retained = await pathIdentity(paths.retained);
  if (current && !sameIdentity(current, journal.original) && !sameIdentity(current, journal.replacement)) throw new Error('restore_current_root_changed');
  if (candidate && !sameIdentity(candidate, journal.replacement)) throw new Error('restore_candidate_root_changed');
  if (retained && !sameIdentity(retained, journal.original)) throw new Error('restore_retained_root_changed');
  const isOriginal = !!current && sameIdentity(current, journal.original);
  const isReplacement = !!current && sameIdentity(current, journal.replacement);
  // Only the three reachable rename states are accepted. Duplicate or missing
  // identities are evidence of an external change and never repaired blindly.
  if (!(isOriginal && candidate && !retained) && !(isReplacement && !candidate && retained)
    && !(!current && candidate && retained)) throw new Error('restore_switch_layout_invalid');
  return { journal, current: isOriginal ? 'original' : isReplacement ? 'replacement' : 'absent',
    choices: ['original', 'replacement'] };
}

async function loadSwitch(dataRoot: string): Promise<{ paths: OwnedSwitchPaths; journal: DataRootSwitchJournal } | null> {
  if (!isAbsolute(dataRoot)) throw new Error('restore_root_invalid');
  const name = rootName.parse(basename(dataRoot)), parent = await canonicalDirectory(dirname(dataRoot));
  const file = join(parent, '.' + name + '.ariadne-restore-journal.json');
  if (!await exists(file)) return null;
  const entry = await lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 8192 || await realpath(file) !== file) throw new Error('restore_journal_invalid');
  const handle = await open(file, 'r');
  let journal: DataRootSwitchJournal;
  try {
    const before = await handle.stat({ bigint: true });
    if (before.size > 8192n) throw new Error('restore_journal_invalid');
    const buffer = Buffer.alloc(8193), read = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat({ bigint: true });
    if (BigInt(read.bytesRead) !== before.size || before.size !== after.size || before.mtimeNs !== after.mtimeNs
      || before.ino !== after.ino) throw new Error('restore_journal_changed');
    journal = journalSchema.parse(JSON.parse(buffer.subarray(0, read.bytesRead).toString('utf8')));
  } finally { await handle.close(); }
  if (journal.rootName !== name) throw new Error('restore_journal_root_invalid');
  return { paths: switchPaths(parent, name, journal.operationId), journal };
}

function switchPaths(parent: string, name: string, operationId: string): OwnedSwitchPaths {
  return { parent, journal: join(parent, '.' + name + '.ariadne-restore-journal.json'), current: join(parent, name),
    candidate: join(parent, dataRootCandidateName(name, operationId)), retained: join(parent, '.' + name + '.ariadne-retained-' + operationId) };
}
async function pathIdentity(path: string): Promise<RootIdentity | null> {
  if (!await exists(path)) return null;
  const entry = await lstat(path, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.ino === 0n || await realpath(path) !== path) throw new Error('restore_owned_root_invalid');
  return { device: entry.dev.toString(), inode: entry.ino.toString() };
}
function sameIdentity(left: RootIdentity, right: RootIdentity): boolean { return left.device === right.device && left.inode === right.inode; }
async function renameOwned(source: string, destination: string, expected: RootIdentity): Promise<void> {
  const found = await pathIdentity(source);
  if (!found || !sameIdentity(found, expected) || await exists(destination)) throw new Error('restore_rename_identity_invalid');
  await rename(source, destination);
}
async function replaceJournal(paths: OwnedSwitchPaths, journal: DataRootSwitchJournal): Promise<void> {
  const temporary = paths.journal + '.' + randomUUID() + '.tmp';
  await writeExclusiveSynced(temporary, Buffer.from(JSON.stringify(journal) + '\n'));
  try { await rename(temporary, paths.journal); }
  catch (error) { await unlink(temporary); throw error; }
}
async function writeExclusiveSynced(path: string, bytes: Buffer): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
async function canonicalDirectory(path: string): Promise<string> {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('restore_parent_invalid');
  return realpath(path);
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false; throw error; }
}

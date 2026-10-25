import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileDraftRepository } from '../src/main/persistence/file-draft-repository';
import { fileDraftRecordsSchema, type FileDraftRecord } from '../src/shared/file-drafts';

const directories: string[] = [];
// Unit boundary fixture only, not an operating-system encryption assertion.
const cipher = { encrypt: (value: string) => Buffer.from(value).toString('base64'), decrypt: (value: string) => Buffer.from(value, 'base64').toString('utf8') };
const version = `workspace-file-v1:${'a'.repeat(64)}`;
function record(path = 'notes.txt'): FileDraftRecord {
  return { draftId: crypto.randomUUID(), workspaceId: 'workspace-a', path, revision: 1, updatedAt: new Date().toISOString(),
    content: 'UNSAVED_PRIVATE_FIXTURE', originalContent: 'original', version, writable: true, exists: true, pendingMutation: null };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ariadne-file-draft-unit-')); directories.push(directory);
  const path = join(directory, 'file-drafts.json'), repository = new FileDraftRepository(path, cipher);
  await repository.initialize(); return { directory, path, repository };
}
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
describe('private file draft repository', () => {
  it('atomically persists baselines and original mutation identities through the cipher boundary', async () => {
    const f = await fixture(), row = record();
    row.pendingMutation = { commandId: crypto.randomUUID(), capturedRevision: 1, state: 'unknown',
      command: { kind: 'workspace.document.save', contractVersion: '5.0', workspaceId: row.workspaceId, path: row.path, content: row.content, expectedVersion: version } };
    const saved = await f.repository.replace({ expectedRevision: 0, records: [row] });
    const raw = await readFile(f.path, 'utf8'); expect(raw).not.toContain(row.content); expect(raw).not.toContain(row.workspaceId);
    const reopened = new FileDraftRepository(f.path, cipher); await reopened.initialize(); expect(await reopened.list()).toEqual(saved);
    expect(saved.records[0]!.pendingMutation!.commandId).toBe(row.pendingMutation.commandId);
  });
  it('rejects a competing catalog CAS without losing the winning revision', async () => {
    const f = await fixture(), a = record(), b = record('other.txt');
    const winner = f.repository.replace({ expectedRevision: 0, records: [a] });
    const stale = f.repository.replace({ expectedRevision: 0, records: [b] });
    await winner; await expect(stale).rejects.toThrow('revision_conflict');
    expect((await f.repository.list()).records).toEqual([a]);
  });
  it('keeps corrupted data untouched and rejects later writes', async () => {
    const f = await fixture(); await writeFile(f.path, '{corrupt fixture');
    const reopened = new FileDraftRepository(f.path, cipher); await reopened.initialize();
    await expect(reopened.list()).rejects.toThrow('storage_unavailable');
    await expect(reopened.replace({ expectedRevision: 0, records: [] })).rejects.toThrow('storage_unavailable');
    expect(await readFile(f.path, 'utf8')).toBe('{corrupt fixture');
  });
  it('retains the staged original command on drift and still accepts later valid mutations', async () => {
    const f = await fixture(), row = record();
    row.pendingMutation = { commandId: crypto.randomUUID(), capturedRevision: 1, state: 'staged',
      command: { kind: 'workspace.document.delete', contractVersion: '5.0', workspaceId: row.workspaceId, path: row.path, expectedVersion: version } };
    await f.repository.replace({ expectedRevision: 0, records: [row] });
    await expect(f.repository.replace({ expectedRevision: 1, records: [{ ...row, revision: 2, pendingMutation: { ...row.pendingMutation, commandId: crypto.randomUUID() } }] })).rejects.toThrow('identity_conflict');
    const known = await f.repository.replace({ expectedRevision: 1, records: [{ ...row, revision: 2, pendingMutation: null }] });
    expect(known.revision).toBe(2);
  });
  it('latches actual disk failure without pretending an empty snapshot was saved', async () => {
    const f = await fixture();
    const impossible = new FileDraftRepository(join(f.directory, 'parent-is-file', 'file-drafts.json'), cipher);
    await impossible.initialize(); await writeFile(join(f.directory, 'parent-is-file'), 'retained');
    await expect(impossible.replace({ expectedRevision: 0, records: [record()] })).rejects.toThrow('storage_unavailable');
    await expect(impossible.list()).rejects.toThrow('storage_unavailable');
    expect(await readFile(join(f.directory, 'parent-is-file'), 'utf8')).toBe('retained');
  });
  it('bounds UTF-8 bytes and exact canonical identities without collapsing case-sensitive files', () => {
    const row = record();
    expect(fileDraftRecordsSchema.safeParse([row, { ...record(row.path) }]).success).toBe(false);
    expect(fileDraftRecordsSchema.safeParse([row, { ...record('NOTES.TXT') }]).success).toBe(true);
    expect(fileDraftRecordsSchema.safeParse([{ ...row, content: '中'.repeat(100000) }]).success).toBe(false);
    expect(fileDraftRecordsSchema.safeParse([{ ...row, path: '../outside.txt' }]).success).toBe(false);
  });
});

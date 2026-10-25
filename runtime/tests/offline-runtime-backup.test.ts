import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { captureOfflineRuntimeBackup } from '../src/adapters/persistence/OfflineRuntimeBackupOwner.js';
import { DATABASE_PATHS } from '../src/adapters/persistence/DatabasePaths.js';
import { acquireSqliteOwnerLease } from '../src/adapters/persistence/SqliteOwnerLease.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) {
  if (!path.resolve(root).startsWith(path.join(path.resolve(os.tmpdir()), 'AriadneOfflineBackup-'))) throw new Error('Unsafe fixture cleanup path.');
  rmSync(root, { recursive: true, force: true });
} });
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'AriadneOfflineBackup-')); roots.push(root);
  const source = path.join(root, 'source'); mkdirSync(source);
  for (const relative of Object.values(DATABASE_PATHS)) {
    const file = path.join(source, relative); mkdirSync(path.dirname(file), { recursive: true });
    const database = new DatabaseSync(file);
    database.exec("PRAGMA user_version=1;CREATE TABLE fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT;INSERT INTO fixture VALUES(1,'source fixture');");
    database.close();
  }
  return { root, source, snapshot: path.join(root, 'snapshot') };
}
function allFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? allFiles(target) : [target];
  });
}

describe('offline Runtime current-storage backup owner', () => {
  it('captures all seven leased SQLite owners including committed WAL after process exit and verified attachment objects', () => {
    const value = fixture(), conversation = path.join(value.source, DATABASE_PATHS.conversation);
    execFileSync(process.execPath, ['--input-type=commonjs', '-e',
      "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec(\"PRAGMA journal_mode=WAL;INSERT INTO fixture VALUES(2,'committed WAL fixture');\");process.exit(0);",
      conversation], { windowsHide: true, stdio: 'pipe' });
    expect(existsSync(conversation + '-wal')).toBe(true);
    const object = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP3sAAAAASUVORK5CYII=', 'base64');
    const digest = createHash('sha256').update(object).digest('hex');
    const relative = 'data/conversation/attachments/v1/objects/' + digest.slice(0, 2) + '/' + digest;
    mkdirSync(path.dirname(path.join(value.source, relative)), { recursive: true });
    writeFileSync(path.join(value.source, relative), object);
    const result = captureOfflineRuntimeBackup(value.source, value.snapshot);
    expect(result.files).toHaveLength(8);
    const copy = new DatabaseSync(path.join(value.snapshot, DATABASE_PATHS.conversation), { readOnly: true });
    try {
      expect(copy.prepare('SELECT count(*) AS total FROM fixture').get()?.total).toBe(2);
      expect(copy.prepare('PRAGMA quick_check').get()?.quick_check).toBe('ok');
    } finally { copy.close(); }
    expect(readFileSync(path.join(value.snapshot, relative))).toEqual(object);
    expect(readFileSync(path.join(value.source, relative))).toEqual(object);
    expect(result.files.find(file => file.path === DATABASE_PATHS.conversation)?.sqlite?.userVersion).toBe(1);
  });

  it('takes every lease before the first copy and releases already acquired leases on owner conflict', () => {
    const value = fixture(), busy = acquireSqliteOwnerLease(path.join(value.source, DATABASE_PATHS.runtimeCommand), 'fixture-runtime-command');
    try {
      expect(() => captureOfflineRuntimeBackup(value.source, value.snapshot)).toThrow('sqlite_owner_lease_unavailable');
      expect(allFiles(value.snapshot)).toEqual([]);
      const lease = acquireSqliteOwnerLease(path.join(value.source, DATABASE_PATHS.agentControl), 'fixture-probe'); lease.close();
    } finally { busy.close(); }
  });

  it('rejects altered attachment objects, removes its completed copies and preserves source bytes', () => {
    const value = fixture(), relative = 'data/conversation/attachments/v1/objects/00/' + '0'.repeat(64);
    mkdirSync(path.dirname(path.join(value.source, relative)), { recursive: true });
    writeFileSync(path.join(value.source, relative), 'altered fixture');
    const source = readFileSync(path.join(value.source, DATABASE_PATHS.conversation));
    expect(() => captureOfflineRuntimeBackup(value.source, value.snapshot)).toThrow('offline_backup_attachment_changed');
    expect(allFiles(value.snapshot)).toEqual([]);
    expect(readFileSync(path.join(value.source, DATABASE_PATHS.conversation))).toEqual(source);
    expect(readFileSync(path.join(value.source, relative), 'utf8')).toBe('altered fixture');
  });

  it('rejects a destination inside the authoritative source before creating it', () => {
    const value = fixture(), invalid = path.join(value.source, 'snapshot');
    expect(() => captureOfflineRuntimeBackup(value.source, invalid)).toThrow('offline_backup_destination_inside_source');
    expect(existsSync(invalid)).toBe(false);
  });
  it('excludes only current-store staging names and refuses malformed or wrong-bucket files', () => {
    const value = fixture(), hash = 'aa' + '0'.repeat(62), folder = path.join(value.source, 'data/conversation/attachments/v1/objects/aa');
    mkdirSync(folder, { recursive: true });
    const valid = hash + '.00000000-0000-4000-8000-000000000001.tmp'; writeFileSync(path.join(folder, valid), 'partial');
    expect(captureOfflineRuntimeBackup(value.source, value.snapshot).unpublishedAttachmentFilesExcluded).toBe(1);
    for (const [index, name] of [hash + '.' + '-'.repeat(36) + '.tmp',
      hash + '.00000000-0000-1000-8000-000000000001.tmp',
      'bb' + hash.slice(2) + '.00000000-0000-4000-8000-000000000001.tmp'].entries()) {
      const target = path.join(folder, name); writeFileSync(target, 'Unowned staging sentinel');
      const snapshot = path.join(value.root, 'refused-' + index);
      expect(() => captureOfflineRuntimeBackup(value.source, snapshot)).toThrow('offline_backup_attachment_object_invalid');
      expect(allFiles(snapshot)).toEqual([]); expect(readFileSync(target, 'utf8')).toBe('Unowned staging sentinel');
      rmSync(target);
    }
    expect(readFileSync(path.join(folder, valid), 'utf8')).toBe('partial');
  });
});

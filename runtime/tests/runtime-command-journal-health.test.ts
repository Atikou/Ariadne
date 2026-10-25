import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteRuntimeCommandJournal } from '../src/adapters/persistence/SqliteRuntimeCommandJournal.js';
import { resolveRuntimeCommandDatabasePath } from '../src/adapters/persistence/runtimeCommandDbMigrations.js';
import { classifySqliteAuthorityFault } from '../src/adapters/persistence/SqliteAuthorityHealth.js';
const roots: string[] = [], journals: SqliteRuntimeCommandJournal[] = [];
const digest = 'a'.repeat(64); const outcome = { ok: true, result: { kind: 'acknowledged' } };
function setup(options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-journal-health-')); roots.push(root);
  const journal = new SqliteRuntimeCommandJournal(options); journals.push(journal); journal.open(root);
  journal.begin('original', digest); journal.complete('original', digest, outcome); return { root, journal };
}
function modify(root: string, sql: string) { const db = new DatabaseSync(resolveRuntimeCommandDatabasePath(root));
  try { db.exec(sql); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { db.close(); } }
afterEach(() => { for (const journal of journals.splice(0)) journal.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('command journal owns its failure evidence', () => {
  it.each(["UPDATE runtime_commands SET outcome_json='{}'", "UPDATE runtime_commands SET command_digest='broken'",
    "UPDATE runtime_commands SET updated_at='invalid'", "UPDATE runtime_commands SET status='uncertain'"])
    ('rejects corrupted original records on reopening before retention changes them: %s', sql => {
      const { root, journal } = setup(); journal.close(); modify(root, sql); const file = resolveRuntimeCommandDatabasePath(root), bytes = readFileSync(file);
      const reopened = new SqliteRuntimeCommandJournal(); journals.push(reopened); let error: unknown;
      try { reopened.open(root); } catch (caught) { error = caught; }
      expect(classifySqliteAuthorityFault('journal', error)).toBe('integrity'); expect(readFileSync(file)).toEqual(bytes);
    });
  it('locks the actual journal after its first decoder error while legitimate identities stay non-fatal', () => {
    const { root, journal } = setup(); expect(() => journal.begin('invalid ', digest)).toThrow('runtime_command_id_invalid');
    expect(journal.begin('original', 'b'.repeat(64))).toEqual({ kind: 'conflict' }); expect(() => journal.assertHealthy()).not.toThrow();
    modify(root, "UPDATE runtime_commands SET outcome_json='{}'");
    expect(() => journal.begin('original', digest)).toThrow('runtime_command_journal_corruption');
    expect(() => journal.assertHealthy()).toThrow('journal_authority_integrity');
    expect(() => journal.begin('new-command', digest)).toThrow('journal_authority_integrity');
    expect(() => journal.getStatus('original')).toThrow('journal_authority_integrity');
  });
  it('does not erase an expired malformed receipt when admitting an unrelated command', () => {
    let now = Date.parse('2026-10-06T00:00:00Z'); const { root, journal } = setup({ now: () => now, retentionMs: 1000 });
    modify(root, "UPDATE runtime_commands SET outcome_json='{}'"); now += 2000;
    expect(() => journal.begin('unrelated', digest)).toThrow('runtime_command_journal_corruption');
    const db = new DatabaseSync(resolveRuntimeCommandDatabasePath(root), { readOnly: true });
    try { expect(db.prepare('SELECT status,outcome_json FROM runtime_commands').get()).toMatchObject({ status: 'completed', outcome_json: '{}' });
      expect(db.prepare('SELECT count(*) AS count FROM runtime_commands').get()).toMatchObject({ count: 1 }); } finally { db.close(); }
  });
});

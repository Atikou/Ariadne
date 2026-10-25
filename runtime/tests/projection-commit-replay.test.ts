import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalPublicProjectionJson, type ProjectionCommit } from '@ariadne/protocol/public';
import { openPublicProjectionDatabase } from '../src/adapters/persistence/PublicProjectionDbSchema.js';
import { appendProjectionLedgerCommit, auditStoredProjectionState } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import { closeOwnedSqliteDatabase } from '../src/adapters/persistence/SqliteOwnerLease.js';
import { DatabaseSync } from 'node:sqlite';
import { resolvePublicProjectionDatabasePath } from '../src/adapters/persistence/PublicProjectionDbSchema.js';

const closes: (() => void)[] = [], roots: string[] = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); for (const root of roots.splice(0)) rmSync(root, {recursive:true,force:true}); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ariadne-exact-replay-')); roots.push(root);
  const opened = openPublicProjectionDatabase(root); closes.push(() => closeOwnedSqliteDatabase(opened.database, opened.ownerLease));
  const at = '2032-01-01T00:00:00.000Z';
  const commit: ProjectionCommit = { contractVersion:'5.0', eventId:'replay-event', sourceId:'replay-source', sourceCursor:1,
    occurredAt:at, changes:[{feature:'messages',operation:'upsert',aggregateId:'replay-message',aggregateVersion:1,projectedAt:at,
      dto:{messageId:'replay-message',sessionId:'replay-session',version:1,role:'assistant',content:'模拟正文'.repeat(20000),
        status:'completed',createdAt:at,updatedAt:at}}] };
  const append = (value = commit) => appendProjectionLedgerCommit(opened.database, opened.streamId, value);
  const positions = () => ['projection_commits','projection_versions','projection_heads','projection_source_checkpoints']
    .map(table => opened.database.prepare(`SELECT count(*) AS total FROM ${table}`).get()!.total);
  append(); return {...opened,root,commit,append,positions};
}
describe('identical canonical Commit replay', () => {
  it('retains the original bytes, cursor, chain, versions and Source after full owner reopening validation', () => {
    const value = fixture(), before = value.database.prepare('SELECT * FROM projection_commits').get();
    for (let index = 0; index < 3; index++) expect(value.append()).toEqual({cursor:1,streamId:value.streamId,replayed:true});
    expect(value.positions()).toEqual([1,1,1,1]);
    expect(value.database.prepare('SELECT * FROM projection_commits').get()).toEqual(before);
    expect(() => auditStoredProjectionState(value.database)).not.toThrow();
  });
  it.each([
    ['source_id','other-source'], ['source_cursor',2], ['contract_version','6.0'],
    ['occurred_at','2032-01-02T00:00:00.000Z'], ['payload_digest',`sha256:${'0'.repeat(64)}`]
  ] as const)('rejects a changed %s even when persisted canonical payload bytes still exactly match', (column, replacement) => {
    const value = fixture();
    value.database.prepare(`UPDATE projection_commits SET ${column}=?`).run(replacement);
    expect(() => value.append()).toThrow('row_mismatch');
    expect(value.positions()).toEqual([1,1,1,1]);
  });
  it('rejects an altered history link on the exact-byte path', () => {
    const value = fixture();
    value.database.prepare('UPDATE projection_commits SET history_digest=?').run(`sha256:${'0'.repeat(64)}`);
    expect(() => value.append()).toThrow('history_digest_mismatch');
    expect(value.positions()).toEqual([1,1,1,1]);
  });
  it('still rejects same-event requested body drift without replacing the old commit', () => {
    const value = fixture();
    const requested = JSON.parse(canonicalPublicProjectionJson(value.commit)) as ProjectionCommit;
    if (requested.changes[0]?.feature !== 'messages' || requested.changes[0].dto === null) throw new Error('fixture_message_missing');
    requested.changes[0].dto.content = '不同正文';
    expect(() => value.append(requested)).toThrow('payload_drift');
    expect(value.positions()).toEqual([1,1,1,1]);
    expect(() => auditStoredProjectionState(value.database)).not.toThrow();
  });
  it('audits all Message version bodies even when only catalog heads are observed', () => {
    const value = fixture();
    for (const table of ['projection_heads','projection_versions']) value.database.prepare(
      `UPDATE ${table} SET dto_json=json_set(dto_json,'$.content','漂移正文')`).run();
    expect(() => auditStoredProjectionState(value.database, () => { throw new Error('unexpected_observation'); },
      ['sessions','runs','decisions'])).toThrow('row_mismatch');
    expect(value.database.isTransaction).toBe(false);
  });
  it('rejects an external write during head observation after auditing one consistent read snapshot', () => {
    const value = fixture(), external = new DatabaseSync(resolvePublicProjectionDatabasePath(value.root));
    try {
      expect(() => auditStoredProjectionState(value.database, () => {
        external.prepare("UPDATE projection_heads SET dto_json=json_set(dto_json,'$.content','外部漂移')").run();
      })).toThrow('audit_external_write');
      expect(value.database.isTransaction).toBe(false);
    } finally { external.close(); }
  });
});

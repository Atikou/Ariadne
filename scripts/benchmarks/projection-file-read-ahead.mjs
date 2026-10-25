import assert from 'node:assert/strict';
import { closeSync, openSync, readSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { resolvePublicProjectionDatabasePath } from '../../runtime/dist/adapters/persistence/PublicProjectionDbSchema.js';

const [fixtureFile, reportName] = process.argv.slice(2);
assert(fixtureFile && /^[a-z0-9][a-z0-9_-]*\.json$/u.test(reportName ?? ''));
const fixture = JSON.parse(readFileSync(resolve(fixtureFile), 'utf8').replace(/^\uFEFF/u, ''));
assert.equal(fixture.format, 'ariadne-projection-electron-capacity.v1');
const root = realpathSync.native(fixture.root);
assert(basename(root).startsWith('AriadneCapacity-'));
assert.equal(dirname(root).toLowerCase(), realpathSync.native(tmpdir()).toLowerCase());
const databasePath = resolvePublicProjectionDatabasePath(join(root, 'runtime')), measurements = [];
for (const readAhead of [true, false, true, false]) {
  const started = performance.now(), cpu = process.cpuUsage(); let readBytes = 0;
  if (readAhead) {
    const buffer = Buffer.allocUnsafe(256 * 1024), descriptor = openSync(databasePath, 'r');
    try { for (;;) { const bytes = readSync(descriptor, buffer, 0, buffer.length, null); if (bytes === 0) break; readBytes += bytes; } }
    finally { closeSync(descriptor); buffer.fill(0); }
    assert.equal(readBytes, statSync(databasePath).size);
  }
  const readAheadMs = performance.now() - started;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=0;');
    const integrityStarted = performance.now();
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    const integrityMs = performance.now() - integrityStarted, used = process.cpuUsage(cpu);
    measurements.push({ readAhead, bufferBytes: readAhead ? 256 * 1024 : 0, readBytes, readAheadMs,
      integrityMs, totalMs: performance.now() - started, cpuMs: (used.user + used.system) / 1000 });
  } finally { database.close(); }
}
const report = { format: 'ariadne-projection-read-ahead.v1', databaseBytes: statSync(databasePath).size, measurements,
  notes: ['Same named TEMP fixture, read-only connections, full integrity check retained.',
    'Raw file bytes are not an integrity proof or a coherent database snapshot; SQLite performs its original audit.',
    'OS cache state is uncontrolled. No production read-ahead/cache configuration is changed by this experiment.'] };
writeFileSync(resolve('artifacts/todo-remediation', reportName), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));

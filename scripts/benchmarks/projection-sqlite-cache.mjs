import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { resolvePublicProjectionDatabasePath } from '../../runtime/dist/adapters/persistence/PublicProjectionDbSchema.js';

const [manifestFile, reportName] = process.argv.slice(2);
assert(manifestFile && /^[a-z0-9][a-z0-9_-]*\.json$/u.test(reportName ?? ''));
const fixture = JSON.parse(readFileSync(resolve(manifestFile), 'utf8').replace(/^\uFEFF/u, ''));
assert.equal(fixture.format, 'ariadne-projection-electron-capacity.v1');
const root = realpathSync.native(fixture.root);
assert(basename(root).startsWith('AriadneCapacity-'));
assert.equal(dirname(root).toLowerCase(), realpathSync.native(tmpdir()).toLowerCase());
const databasePath = resolvePublicProjectionDatabasePath(join(root, 'runtime')), measurements = [];
// Alternating fresh read-only connections keep the comparison within one
// process. This does not evict or control OS cache, and never changes the file.
for (const cacheKiB of [2048, 8192, 32768, 2048, 8192, 32768]) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec(`PRAGMA query_only=ON; PRAGMA busy_timeout=0; PRAGMA cache_size=-${cacheKiB};`);
    const cpu = process.cpuUsage(), started = performance.now();
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    const durationMs = performance.now() - started, used = process.cpuUsage(cpu);
    measurements.push({ cacheKiB, durationMs, cpuMs: (used.user + used.system) / 1000 });
    assert.equal(database.prepare('PRAGMA cache_size').get().cache_size, -cacheKiB);
  } finally { database.close(); }
}
const report = { format: 'ariadne-projection-sqlite-cache.v1', databaseBytes: statSync(databasePath).size,
  sourceFixture: resolve(manifestFile), measurements,
  notes: ['Read-only full integrity checks; same immutable fixture, fresh connection each time.',
    'OS cache state is uncontrolled. This is not a cold-start acceptance or proof of the previous 7222ms cause.',
    'cache_size is a connection-local target page budget, not a total process memory limit.'] };
writeFileSync(resolve('artifacts/todo-remediation', reportName), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));

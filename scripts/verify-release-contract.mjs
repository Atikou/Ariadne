import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appPackage = readJson('app/package.json');
const schemaManifest = readJson('runtime/config/schema-compatibility.json');
const embeddingManifest = readJson('runtime/config/embedding-models.json');
const verificationMatrix = readJson('docs/verification-matrix.json');
const includePath = path.resolve(
  projectRoot,
  'app',
  appPackage.build?.nsis?.include ?? ''
);

assert(appPackage.build?.nsis?.oneClick === false, 'NSIS must use assisted install mode.');
assert(
  appPackage.build?.nsis?.deleteAppDataOnUninstall === false,
  'Silent uninstall must preserve user data.'
);
assert(existsSync(includePath), 'NSIS lifecycle include is missing.');
const include = readFileSync(includePath, 'utf8');
for (const marker of [
  '!macro customInit',
  '!macro customUnInit',
  '!macro customUnInstall',
  'MB_DEFBUTTON2',
  'Ariadne.WindowsSandbox.exe'
]) {
  assert(include.includes(marker), `NSIS lifecycle contract is missing: ${marker}`);
}

assert(schemaManifest.manifestVersion === 1, 'Schema compatibility manifest version is invalid.');
assert(schemaManifest.policy?.forwardPath === 'N-1-to-N', 'N-1 to N upgrade policy is missing.');
assert(
  schemaManifest.policy?.downgradePath === 'restore-versioned-backup',
  'Backup-based downgrade policy is missing.'
);
assert(
  schemaManifest.policy?.newerDatabaseWrite === 'rejected',
  'Newer database write rejection policy is missing.'
);
assert(embeddingManifest.schemaVersion === 1, 'Embedding asset manifest version is invalid.');
assert(
  embeddingManifest.models?.every((model) =>
    model.weightsCommitted === false
    && /^[a-f0-9]{64}$/u.test(model.sha256)
    && new URL(model.source).protocol === 'https:'),
  'Embedding assets must be external, HTTPS, and SHA-256 pinned.'
);

const matrixStatuses = new Set([
  'verified',
  'partial',
  'not_accepted',
  'not_applicable'
]);
assert(verificationMatrix.schemaVersion === 1, 'Verification matrix version is invalid.');
assert(
  Array.isArray(verificationMatrix.rows) && verificationMatrix.rows.length > 0,
  'Verification matrix must contain module rows.'
);
for (const row of verificationMatrix.rows) {
  assert(typeof row.module === 'string' && row.module.length > 0, 'Matrix module is invalid.');
  assert(
    Array.isArray(row.source) && row.source.length > 0,
    `Matrix module ${row.module} has no source mapping.`
  );
  for (const source of row.source) {
    assert(
      existsSync(path.join(projectRoot, source)),
      `Matrix module ${row.module} references missing source: ${source}`
    );
  }
  for (const dimension of ['unit', 'integration', 'realModel', 'realWindow', 'realMachine']) {
    assert(
      matrixStatuses.has(row[dimension]),
      `Matrix module ${row.module} has invalid ${dimension} status.`
    );
  }
}

console.log('release-contract: installer, migration, model asset, and acceptance matrix contracts verified');

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(projectRoot, relativePath), 'utf8'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

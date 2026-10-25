import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './verify-persistence-contract.mjs';
import './verify-persistence-extension-contracts.mjs';
import { assertRetiredRuntimeAbsent } from './verify-retired-runtime-absence.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assertRetiredRuntimeAbsent(path.join(projectRoot, 'runtime'));
const appPackage = readJson('app/package.json');
const schemaManifest = readJson('runtime/config/schema-compatibility.json');
const embeddingManifest = readJson('runtime/config/embedding-models.json');
const toolArtifactManifest = readJson('runtime/config/first-party-tool-artifacts.json');
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
// Verify the owner's source constants, so a stale manifest cannot pass merely
// because it still describes the expected upgrade policy.
const schemaOwners = {
  modelCapability: ['runtime/src/model/capability/ModelCapabilityDbSchema.ts', 'MODEL_CAPABILITY_DB_SCHEMA_VERSION'],
  agentControl: ['runtime/src/adapters/persistence/agentControlDbSchema.ts', 'AGENT_CONTROL_DB_SCHEMA_VERSION'],
  conversation: ['runtime/src/adapters/persistence/ConversationDbSchema.ts', 'CONVERSATION_DB_SCHEMA_VERSION'],
  publicProjection: ['runtime/src/adapters/persistence/PublicProjectionDbSchema.ts', 'PUBLIC_PROJECTION_CURRENT_DB_SCHEMA_VERSION'],
  runtimeCommand: ['runtime/src/adapters/persistence/runtimeCommandDbMigrations.ts', 'RUNTIME_COMMAND_DB_SCHEMA_VERSION'],
  longMemory: ['runtime/src/adapters/persistence/LongMemoryDbSchema.ts', 'LONG_MEMORY_DB_SCHEMA_VERSION'],
  productivity: ['runtime/src/adapters/persistence/ProductivityDbSchema.ts', 'PRODUCTIVITY_DB_SCHEMA_VERSION'],
  traceIndex: ['runtime/src/trace/traceIndexMigrations.ts', 'TRACE_INDEX_SCHEMA_VERSION']
};
assert(
  JSON.stringify(Object.keys(schemaManifest.databases ?? {}).sort()) === JSON.stringify(Object.keys(schemaOwners).sort()),
  'Schema manifest must name every declared database owner exactly once.'
);
for (const [database, [ownerPath, constant]] of Object.entries(schemaOwners)) {
  const source = readFileSync(path.join(projectRoot, ownerPath), 'utf8');
  const matches = [...source.matchAll(new RegExp(`export const ${constant} = (\\d+);`, 'gu'))];
  assert(matches.length === 1, `Database ${database} must declare one numeric schema version in its owner.`);
  const version = Number(matches[0][1]);
  assert(schemaManifest.databases[database].currentSchema === version,
    `Database ${database} manifest schema does not match owner version ${version}.`);
  assert(schemaManifest.databases[database].minimumForwardSource === Math.max(0, version - 1),
    `Database ${database} minimum forward source must match the N-1 policy.`);
}
const runtimePackage = readJson('runtime/package.json');
for (const retiredEntry of ['LegacyLongMemoryImport', 'import-legacy-long-memory', 'migrate-scheduler-v3', 'storage', 'main']) {
  assert(!existsSync(path.join(projectRoot, `runtime/src/cli/${retiredEntry}.ts`)),
    `Retired CLI must not exist: ${retiredEntry}`);
}
assert(!Object.keys(runtimePackage.scripts).some(script => /import:.*legacy|scheduler:migrate|storage:(status|cleanup)/u.test(script)),
  'Retired import and storage commands must not be registered.');
assert(!('offlineLegacyImport' in schemaManifest.databases.longMemory), 'Retired data import is unsupported.');
assert(embeddingManifest.schemaVersion === 1, 'Embedding asset manifest version is invalid.');
assert(
  toolArtifactManifest.schemaVersion === 1
  && toolArtifactManifest.algorithm === 'ariadne-tool-module-closure-v1'
  && Array.isArray(toolArtifactManifest.modules)
  && toolArtifactManifest.modules.length > 0,
  'First-party Tool artifact manifest is invalid.'
);
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

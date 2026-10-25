import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertRetiredRuntimeAbsent } from './verify-retired-runtime-absence.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetArguments = process.argv.slice(2);
if (assetArguments.length && (assetArguments.length !== 2 || assetArguments[0] !== '--unpacked-root' || !path.isAbsolute(assetArguments[1])))
  throw new Error('Usage: verify-packaged-runtime-assets.mjs [--unpacked-root <absolute directory>]');
const unpackedRoot = assetArguments.length ? path.resolve(assetArguments[1]) : path.join(projectRoot, 'dist', 'electron', 'win-unpacked');
const resourcesRoot = path.join(unpackedRoot, 'resources');
const runtimeRoot = path.join(
  resourcesRoot,
  'runtime',
  'node_modules',
  '@ariadne',
  'runtime'
);
const runner = path.join(resourcesRoot, 'runtime-runner', 'node.exe');
const runnerManifest = path.join(resourcesRoot, 'runtime-runner', '.ariadne-node-runtime.json');
const runtimeEntry = path.join(runtimeRoot, 'dist', 'entry', 'runtime-process.js');
const storageMaintenanceEntry = path.join(runtimeRoot, 'dist', 'entry', 'storage-maintenance-process.js');
const dataRootSwitchEntry = path.join(resourcesRoot, 'app.asar.unpacked', 'out', 'main', 'data-root-switch-process.cjs');
const headlessEntry = path.join(runtimeRoot, 'dist', 'entry', 'headless.js');
const toolArtifactVerifier = path.join(
  runtimeRoot,
  'dist',
  'cli',
  'verify-first-party-tool-artifacts.js'
);
const toolArtifactManifest = path.join(
  runtimeRoot,
  'config',
  'first-party-tool-artifacts.json'
);
const sandboxRoot = path.join(runtimeRoot, '.runtime', 'windows-sandbox');
const sandboxHelper = path.join(sandboxRoot, 'Ariadne.WindowsSandbox.exe');
const sandboxManifestFile = path.join(
  sandboxRoot,
  'Ariadne.WindowsSandbox.manifest.json'
);
const python = path.join(runtimeRoot, '.runtime', 'transformers', 'Scripts', 'python.exe');
const pythonManifest = path.join(
  runtimeRoot,
  '.runtime',
  'transformers',
  '.ariadne-runtime.json'
);

assertRetiredRuntimeAbsent(runtimeRoot);
for (const dependency of ['@lancedb/lancedb', 'web-tree-sitter', 'tree-sitter-wasms']) {
  assert(!existsSync(path.join(resourcesRoot, 'runtime', 'node_modules', dependency)),
    `Retired dependency was included in packaged Runtime: ${dependency}`);
}

for (const file of [
  runner,
  runnerManifest,
  runtimeEntry,
  storageMaintenanceEntry,
  dataRootSwitchEntry,
  headlessEntry,
  toolArtifactVerifier,
  toolArtifactManifest,
  sandboxHelper,
  sandboxManifestFile,
  python,
  pythonManifest,
  path.join(runtimeRoot, 'config', 'schema-compatibility.json'),
  path.join(runtimeRoot, 'config', 'embedding-models.json')
]) {
  assert(existsSync(file), `Packaged Runtime asset is missing: ${relative(file)}`);
}

const sandboxManifest = readJson(sandboxManifestFile);
assert(
  sandboxManifest.schema === 'ariadne_windows_sandbox_distribution'
  && sandboxManifest.version === 1
  && sandboxManifest.trust?.kind === 'authenticode_publisher'
  && sandboxManifest.sha256 === sha256(sandboxHelper),
  'Packaged native Sandbox manifest does not match its helper.'
);

const nodeVersion = run(runner, ['--version']).trim();
const expectedNodeVersion = readJson(runnerManifest).version;
assert(nodeVersion === `v${expectedNodeVersion}`, 'Packaged Node runner version mismatch.');

// The restore switch helper is a standalone Node bundle outside ASAR. Without
// its private owning IPC channel it must reject execution before touching data.
const unauthenticatedHelper = spawnSync(runner, [dataRootSwitchEntry], {
  cwd: projectRoot, encoding: 'utf8', windowsHide: true, timeout: 10000
});
assert(!unauthenticatedHelper.error && unauthenticatedHelper.status === 1
  && unauthenticatedHelper.stdout === '' && unauthenticatedHelper.stderr === '',
  'Packaged restore helper is not standalone or accepted an unowned invocation.');

run(runner, [toolArtifactVerifier]);

run(python, [
  '-c',
  "import torch, transformers, safetensors, accelerate; print('transformers-runtime-ok')"
]);

console.log('packaged-runtime: native Sandbox, Node runner, model Runtime, private restore helpers, and manifests verified');

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(command)} failed during packaged Runtime verification.`);
  }
  return result.stdout;
}

function relative(file) {
  return path.relative(projectRoot, file).replaceAll('\\', '/');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

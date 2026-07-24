import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const unpackedRoot = path.join(projectRoot, 'dist', 'electron', 'win-unpacked');
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
const headlessEntry = path.join(runtimeRoot, 'dist', 'entry', 'headless.js');
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

for (const file of [
  runner,
  runnerManifest,
  runtimeEntry,
  headlessEntry,
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

run(python, [
  '-c',
  "import torch, transformers, safetensors, accelerate; print('transformers-runtime-ok')"
]);

console.log('packaged-runtime: native Sandbox, Node runner, model Runtime, and manifests verified');

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

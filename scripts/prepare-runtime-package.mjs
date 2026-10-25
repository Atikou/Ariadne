import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertRetiredRuntimeAbsent } from './verify-retired-runtime-absence.mjs';

const NODE_VERSION = '24.16.0';
const WINDOWS_NODE_ARTIFACTS = {
  x64: {
    filename: `node-v${NODE_VERSION}-win-x64.zip`,
    sha256: 'edaca9bd58ec8e92037dac4e877d52f6b8f430b81c18b57e264b4e2fb111cd56'
  },
  arm64: {
    filename: `node-v${NODE_VERSION}-win-arm64.zip`,
    sha256: '14834611d4c6b3c06054e7007732b90474c16e0b32f395e05b55a571ef71c6d2'
  }
};

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = path.join(projectRoot, 'runtime');
const distributionRoot = path.join(projectRoot, 'packaging', 'runtime');
const packageWorkRoot = path.join(projectRoot, 'app', '.runtime-package');
const runnerRoot = path.join(packageWorkRoot, 'runtime-runner');
const dependenciesOnly = process.argv.slice(2).includes('--dependencies-only');
const targetArchitecture = readTargetArchitecture(process.argv.slice(2));

if (process.platform !== 'win32') {
  throw new Error('Ariadne Windows packaging must run on Windows.');
}
if (!(targetArchitecture in WINDOWS_NODE_ARTIFACTS)) {
  throw new Error(`Unsupported Windows packaging architecture: ${targetArchitecture}`);
}

await prepareNodeRunner();
installRuntimeDependencies();
if (!dependenciesOnly) {
  publishTrustedNativeSandbox();
  installTransformersRuntime();
  verifyProductionAssets();
}
console.log(`runtime-package: prepared ${dependenciesOnly ? 'dependency staging' : 'production assets'}`);

async function prepareNodeRunner() {
  const artifact = WINDOWS_NODE_ARTIFACTS[targetArchitecture];
  const markerPath = path.join(runnerRoot, '.ariadne-node-runtime.json');
  const marker = JSON.stringify({ version: NODE_VERSION, artifactSha256: artifact.sha256 }, null, 2);
  if (
    existsSync(path.join(runnerRoot, 'node.exe'))
    && existsSync(path.join(runnerRoot, 'npm.cmd'))
    && existsSync(path.join(runnerRoot, 'LICENSE'))
    && existsSync(markerPath)
    && readFileSync(markerPath, 'utf8').trim() === marker.trim()
  ) {
    return;
  }

  mkdirSync(packageWorkRoot, { recursive: true });
  const archivePath = path.join(packageWorkRoot, artifact.filename);
  const extractRoot = path.join(packageWorkRoot, `node-v${NODE_VERSION}-extract`);
  const url = `https://nodejs.org/download/release/v${NODE_VERSION}/${artifact.filename}`;
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Node Runtime download failed: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const actualSha256 = createHash('sha256').update(archive).digest('hex');
  if (actualSha256 !== artifact.sha256) {
    throw new Error(`Node Runtime checksum mismatch: expected=${artifact.sha256}, actual=${actualSha256}`);
  }

  writeFileSync(archivePath, archive);
  removeGeneratedDirectory(extractRoot);
  removeGeneratedDirectory(runnerRoot);
  mkdirSync(extractRoot, { recursive: true });
  run('tar', ['-xf', archivePath, '-C', extractRoot], projectRoot);
  const extracted = readdirSync(extractRoot, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && entry.name === artifact.filename.replace(/\.zip$/u, ''));
  if (!extracted) throw new Error(`Node Runtime archive root is missing: ${artifact.filename}`);
  cpSync(path.join(extractRoot, extracted.name), runnerRoot, { recursive: true });
  writeFileSync(markerPath, `${marker}\n`, 'utf8');
  rmSync(archivePath, { force: true });
  removeGeneratedDirectory(extractRoot);
}

function readTargetArchitecture(arguments_) {
  const inline = arguments_.find((argument) => argument.startsWith('--arch='));
  const index = arguments_.indexOf('--arch');
  const value = inline?.slice('--arch='.length) ?? (index >= 0 ? arguments_[index + 1] : undefined);
  return value?.trim() || 'x64';
}

function installRuntimeDependencies() {
  const node = path.join(runnerRoot, 'node.exe');
  const npmCli = path.join(runnerRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  // Local file packages retain their version while dependencies change. npm
  // ci cannot detect stale transitive metadata from that unchanged version.
  const locked = JSON.parse(readFileSync(path.join(distributionRoot, 'package-lock.json'), 'utf8'));
  const distribution = JSON.parse(readFileSync(path.join(distributionRoot, 'package.json'), 'utf8'));
  for (const [name, reference] of Object.entries(distribution.dependencies)) {
    if (!reference.startsWith('file:')) throw new Error('Runtime distribution local owner reference required.');
    const source = JSON.parse(readFileSync(path.resolve(distributionRoot, reference.slice(5), 'package.json'), 'utf8'));
    const recorded = locked.packages?.['node_modules/' + name];
    for (const field of ['version', 'dependencies', 'engines']) {
      const canonical = value => JSON.stringify(value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value ?? null);
      if (canonical(source[field]) !== canonical(recorded?.[field])) throw new Error('Runtime distribution lock is stale for ' + name + ': ' + field);
    }
  }
  run(node, [npmCli, 'ci', '--omit=dev', '--workspaces=false', '--install-links'], distributionRoot, {
    PATH: `${runnerRoot}${path.delimiter}${process.env.PATH ?? ''}`
  });
  const entry = path.join(
    distributionRoot,
    'node_modules',
    '@ariadne',
    'runtime',
    'dist',
    'entry',
    'runtime-process.js'
  );
  if (!existsSync(entry)) throw new Error(`Packaged Runtime entry is missing: ${entry}`);
  assertRetiredRuntimeAbsent(path.dirname(path.dirname(path.dirname(entry))));
  for (const dependency of ['@lancedb/lancedb', 'web-tree-sitter', 'tree-sitter-wasms'])
    if (existsSync(path.join(distributionRoot, 'node_modules', dependency))) throw new Error('Retired Runtime distribution dependency: ' + dependency);
}

function publishTrustedNativeSandbox() {
  run(
    path.join(runnerRoot, 'node.exe'),
    [path.join(runtimeRoot, 'scripts', 'publish-windows-sandbox.mjs'), '--trusted', '--self-contained'],
    projectRoot
  );
}

function installTransformersRuntime() {
  run(
    path.join(runnerRoot, 'node.exe'),
    [path.join(runtimeRoot, 'scripts', 'setup-model-runtimes.mjs')],
    projectRoot
  );
}

function verifyProductionAssets() {
  const required = [
    path.join(runtimeRoot, '.runtime', 'windows-sandbox', 'Ariadne.WindowsSandbox.exe'),
    path.join(runtimeRoot, '.runtime', 'windows-sandbox', 'Ariadne.WindowsSandbox.manifest.json'),
    path.join(runtimeRoot, '.runtime', 'transformers', '.ariadne-runtime.json'),
    path.join(runtimeRoot, '.runtime', 'transformers', 'Scripts', 'python.exe')
  ];
  const missing = required.filter((file) => !existsSync(file));
  if (missing.length > 0) {
    throw new Error(`Production Runtime assets are incomplete:\n${missing.join('\n')}`);
  }
}

function removeGeneratedDirectory(target) {
  const relative = path.relative(packageWorkRoot, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to remove a path outside package work root: ${target}`);
  }
  if (realpathSync.native(packageWorkRoot) !== packageWorkRoot || (existsSync(target)
    && (lstatSync(target).isSymbolicLink() || realpathSync.native(target) !== target)))
    throw new Error(`Refusing an aliased package work directory: ${target}`);
  rmSync(target, { recursive: true, force: true });
}

function run(command, args, cwd, environment = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...environment },
    stdio: 'inherit',
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} failed with exit ${String(result.status)}`);
  }
}

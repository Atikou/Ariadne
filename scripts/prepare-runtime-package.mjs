import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const NODE_VERSION = '22.23.1';
const WINDOWS_NODE_ARTIFACTS = {
  x64: {
    filename: `node-v${NODE_VERSION}-win-x64.zip`,
    sha256: '7df0bc9375723f4a86b3aa1b7cc73342423d9677a8df4538aca31a049e309c29'
  },
  arm64: {
    filename: `node-v${NODE_VERSION}-win-arm64.zip`,
    sha256: 'b470fdfe3502c05151656e06d495e3f47544f2ee8b1d9c8705090f2dd5996bd0'
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

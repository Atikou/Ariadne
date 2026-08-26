import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedNode = '22.13.1';
const expectedNpm = '10.9.2';
const failures = [];

const rootPackage = readJson('package.json');
const rootLock = readJson('package-lock.json');
const runtimeDistributionPackage = readJson('packaging/runtime/package.json');
const runtimeDistributionLock = readJson('packaging/runtime/package-lock.json');
const nvmVersion = readFileSync(path.join(projectRoot, '.nvmrc'), 'utf8').trim();

assertEqual(nvmVersion, expectedNode, '.nvmrc version');
assertEqual(process.versions.node, expectedNode, 'Node.js version');
assertEqual(detectNpmVersion(), expectedNpm, 'npm version');
assertEqual(rootPackage.packageManager, `npm@${expectedNpm}`, 'packageManager');
assertEqual(rootPackage.engines?.node, expectedNode, 'engines.node');
assertEqual(rootPackage.engines?.npm, expectedNpm, 'engines.npm');
assertEqual(rootLock.lockfileVersion, 3, 'root lockfileVersion');
assertEqual(runtimeDistributionLock.lockfileVersion, 3, 'runtime distribution lockfileVersion');
assertEqual(rootLock.packages?.['']?.engines?.node, expectedNode, 'root lock engines.node');
assertEqual(rootLock.packages?.['']?.engines?.npm, expectedNpm, 'root lock engines.npm');
assertEqual(
  JSON.stringify(rootLock.packages?.['']?.workspaces),
  JSON.stringify(rootPackage.workspaces),
  'root lock workspaces'
);
assertEqual(
  runtimeDistributionLock.packages?.['']?.name,
  runtimeDistributionPackage.name,
  'runtime distribution lock package name'
);

const status = git(['status', '--porcelain=v1', '--untracked-files=all']);
if (status.trim() !== '') failures.push('Git checkout is not clean.');

const trackedIgnored = git(['ls-files', '-ci', '--exclude-standard', '-z']);
if (trackedIgnored !== '') {
  failures.push(`Ignored files are tracked: ${formatNulPaths(trackedIgnored)}`);
}

const trackedFiles = splitNul(git(['ls-files', '-z']));
for (const relative of trackedFiles) {
  const normalized = relative.replaceAll('\\', '/');
  if (isForbiddenTrackedPath(normalized)) {
    failures.push(`Forbidden generated, runtime, or secret path is tracked: ${normalized}`);
  }
  if (!isTextPolicyFile(normalized)) continue;
  const content = readFileSync(path.join(projectRoot, relative), 'utf8');
  if (/C:\\Users\\Administrator|E:\\Project\\Ariadne/i.test(content)) {
    failures.push(`Machine-specific absolute path is stored in ${normalized}.`);
  }
}

for (const packagePath of trackedFiles.filter((file) => file.endsWith('package.json'))) {
  validateLocalDependencies(packagePath, readJson(packagePath));
}

const workflow = readFileSync(path.join(projectRoot, '.github/workflows/ci.yml'), 'utf8');
for (const line of workflow.split(/\r?\n/)) {
  const match = line.match(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/);
  if (match !== null && !/@[0-9a-f]{40}$/.test(match[1])) {
    failures.push(`CI action is not pinned to an immutable commit: ${match[1]}`);
  }
}
if (!workflow.includes("node-version-file: '.nvmrc'")) {
  failures.push('CI does not consume the repository Node.js version pin.');
}
if (!workflow.includes('run: npm run check:architecture')) {
  failures.push('CI bypasses the complete architecture command.');
}

if (failures.length > 0) {
  process.stderr.write(`Source reproducibility check failed:\n${failures.map((item) => `  - ${item}`).join('\n')}\n`);
  process.exit(1);
}

process.stdout.write(
  `Source reproducibility check passed: ${String(trackedFiles.length)} tracked files, Node ${expectedNode}, npm ${expectedNpm}.\n`
);

function readJson(relative) {
  return JSON.parse(readFileSync(path.join(projectRoot, relative), 'utf8'));
}

function git(args) {
  return execFileSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function detectNpmVersion() {
  const userAgent = process.env.npm_config_user_agent ?? '';
  const match = userAgent.match(/(?:^|\s)npm\/([^\s]+)/);
  if (match !== null) return match[1];
  const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim();
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    failures.push(`${label} mismatch: expected ${String(expected)}, received ${String(actual)}.`);
  }
}

function splitNul(value) {
  return value === '' ? [] : value.split('\0').filter(Boolean);
}

function formatNulPaths(value) {
  return splitNul(value).join(', ');
}

function isForbiddenTrackedPath(relative) {
  const segments = relative.toLowerCase().split('/');
  const basename = segments.at(-1) ?? '';
  return segments.some((segment) => (
    segment === 'node_modules'
    || segment === 'artifacts'
    || segment === '.runtime'
    || segment === 'coverage'
    || segment === 'dist'
    || segment === 'out'
  )) || (
    basename === '.env'
    || basename.startsWith('.env.')
    || /\.(?:db|sqlite|sqlite3|pem|key|pfx|p12|log)$/i.test(basename)
  );
}

function isTextPolicyFile(relative) {
  return /\.(?:cjs|css|html|js|json|jsx|md|mjs|ps1|toml|ts|tsx|txt|yml|yaml)$/i.test(relative)
    || path.basename(relative).startsWith('.env');
}

function validateLocalDependencies(packagePath, packageJson) {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, specifier] of Object.entries(packageJson[field] ?? {})) {
      if (typeof specifier !== 'string' || !specifier.startsWith('file:')) continue;
      const target = specifier.slice('file:'.length);
      if (path.isAbsolute(target)) {
        failures.push(`${packagePath}: ${field}.${name} uses an absolute file dependency.`);
        continue;
      }
      const resolved = path.resolve(projectRoot, path.dirname(packagePath), target);
      if (!isInsideProject(resolved) || !existsSync(resolved)) {
        failures.push(`${packagePath}: ${field}.${name} escapes the repository or is missing.`);
      }
    }
  }
}

function isInsideProject(absolute) {
  const relative = path.relative(projectRoot, absolute);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

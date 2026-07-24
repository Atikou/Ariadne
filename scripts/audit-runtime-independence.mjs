import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = path.join(projectRoot, 'runtime');
const productionRoots = [
  path.join(runtimeRoot, 'src'),
  path.join(runtimeRoot, 'scripts'),
  path.join(runtimeRoot, 'config'),
  path.join(runtimeRoot, 'native'),
  path.join(projectRoot, 'app', 'src'),
  path.join(projectRoot, 'packages', 'protocol', 'src'),
  path.join(projectRoot, 'packaging')
];
const sourceExtensions = new Set([
  '.cjs', '.cs', '.js', '.json', '.mjs', '.ps1', '.py', '.ts', '.tsx'
]);
const skippedDirectories = new Set([
  '.git', '.runtime', 'bin', 'dist', 'node_modules', 'obj', 'out'
]);

const productionFiles = productionRoots.flatMap((root) => walk(root));
const legacyBrandReferences = findMatches(
  productionFiles,
  /\bagent[-_ ]?relay(?![a-z0-9])/iu,
);
const inboundHttpIndicators = findMatches(
  walk(path.join(runtimeRoot, 'src')),
  /\b(?:createServer|http\.createServer|https\.createServer)\s*\(|\.listen\s*\(|\b(?:express|fastify)\s*\(/u
);
const externalFileDependencies = findExternalFileDependencies();
const rootPackage = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const forbiddenRootScripts = Object.entries(rootPackage.scripts ?? {})
  .filter(([name, command]) =>
    /\bagent[-_ ]?relay(?![a-z0-9])/iu.test(`${name} ${String(command)}`))
  .map(([name]) => name);
const runtimeServerDirectoryAbsent = !existsSync(path.join(runtimeRoot, 'src', 'server'));
const runtimePublicDirectoryAbsent = !existsSync(path.join(runtimeRoot, 'public'));

const report = {
  ok: (
    legacyBrandReferences.length === 0
    && inboundHttpIndicators.length === 0
    && externalFileDependencies.length === 0
    && forbiddenRootScripts.length === 0
    && runtimeServerDirectoryAbsent
    && runtimePublicDirectoryAbsent
  ),
  productionFileCount: productionFiles.length,
  runtimeServerDirectoryAbsent,
  runtimePublicDirectoryAbsent,
  legacyBrandReferences,
  inboundHttpIndicators,
  externalFileDependencies,
  forbiddenRootScripts
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) process.exitCode = 1;

function walk(root) {
  if (!existsSync(root)) return [];
  const stat = statSync(root);
  if (stat.isFile()) return sourceExtensions.has(path.extname(root).toLowerCase()) ? [root] : [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else if (sourceExtensions.has(path.extname(entry.name).toLowerCase())) files.push(absolute);
  }
  return files;
}

function findMatches(files, pattern) {
  const matches = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (pattern.test(text)) matches.push(relative(file));
    pattern.lastIndex = 0;
  }
  return matches.sort();
}

function findExternalFileDependencies() {
  const manifests = [
    path.join(projectRoot, 'package.json'),
    path.join(projectRoot, 'app', 'package.json'),
    path.join(projectRoot, 'runtime', 'package.json'),
    path.join(projectRoot, 'packages', 'protocol', 'package.json'),
    path.join(projectRoot, 'packaging', 'runtime', 'package.json')
  ];
  const failures = [];
  for (const manifest of manifests) {
    if (!existsSync(manifest)) continue;
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, specifier] of Object.entries(parsed[section] ?? {})) {
        if (typeof specifier !== 'string' || !specifier.startsWith('file:')) continue;
        const target = path.resolve(path.dirname(manifest), specifier.slice('file:'.length));
        if (!isInsideProject(target)) {
          failures.push(`${relative(manifest)}:${section}.${name}`);
        }
      }
    }
  }
  return failures.sort();
}

function isInsideProject(target) {
  const relativeTarget = path.relative(projectRoot, target);
  return relativeTarget === '' || (
    relativeTarget !== '..'
    && !relativeTarget.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativeTarget)
  );
}

function relative(file) {
  return path.relative(projectRoot, file).replaceAll('\\', '/');
}

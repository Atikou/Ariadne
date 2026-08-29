import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_ARTIFACT_ALGORITHM = 'ariadne-tool-module-closure-v1';
const TOOL_IMPLEMENTATION_MODULES = Object.freeze([
  'dist/composition/first-party-tools/BrowserAgentTools.js',
  'dist/composition/first-party-tools/ComputerReadAgentTools.js',
  'dist/composition/first-party-tools/LiveWorkControlAgentTools.js',
  'dist/composition/first-party-tools/LiveWorkStartAgentTools.js',
  'dist/composition/first-party-tools/McpAgentTools.js',
  'dist/composition/first-party-tools/ProtectedResultAgentTools.js',
  'dist/composition/first-party-tools/WorkspaceAgentTools.js',
  'dist/composition/first-party-tools/WorkspaceFileAgentTools.js',
  'dist/composition/first-party-tools/WorkspaceSearchAgentTools.js',
  'dist/composition/runtime-capabilities/ProductionSkillLoadTool.js'
]);

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = join(runtimeRoot, 'dist');
const runtimeManifestPath = join(distRoot, 'runtime-build.json');
const toolManifestPath = join(runtimeRoot, 'config', 'first-party-tool-artifacts.json');
const runtimePackage = JSON.parse(
  await readFile(join(runtimeRoot, 'package.json'), 'utf8')
);
const files = (await listJavaScriptFiles(distRoot))
  .map((absolutePath) => ({
    absolutePath,
    path: relative(runtimeRoot, absolutePath).split(sep).join('/')
  }))
  .sort((left, right) => compareCodeUnits(left.path, right.path));
const filesByPath = new Map(files.map((file) => [file.path, file]));
const contentsByPath = new Map();
await Promise.all(files.map(async (file) => {
  contentsByPath.set(file.path, await readFile(file.absolutePath));
}));

const toolManifest = {
  schemaVersion: 1,
  algorithm: TOOL_ARTIFACT_ALGORITHM,
  modules: TOOL_IMPLEMENTATION_MODULES.map((modulePath) =>
    buildToolModuleArtifact(modulePath)
  )
};
await writeIfChanged(toolManifestPath, `${JSON.stringify(toolManifest, null, 2)}\n`);

const runtimeHash = createHash('sha256');
for (const file of files) {
  const content = requireContent(file.path);
  runtimeHash.update(file.path.slice('dist/'.length));
  runtimeHash.update('\0');
  runtimeHash.update(String(content.byteLength));
  runtimeHash.update('\0');
  runtimeHash.update(content);
  runtimeHash.update('\0');
}
const runtimeManifest = {
  schemaVersion: 1,
  runtimeVersion: runtimePackage.version,
  fingerprint: runtimeHash.digest('hex')
};
await writeIfChanged(runtimeManifestPath, `${JSON.stringify(runtimeManifest, null, 2)}\n`);

function buildToolModuleArtifact(modulePath) {
  if (!filesByPath.has(modulePath)) {
    throw new Error(`Tool implementation module is missing from Runtime build: ${modulePath}`);
  }
  const closure = collectRuntimeClosure(modulePath);
  const artifactFiles = closure.map((path) => {
    const content = requireContent(path);
    return {
      path,
      byteLength: content.byteLength,
      sha256: digest(content)
    };
  });
  return {
    module: modulePath,
    files: artifactFiles,
    artifactDigest: digest(canonicalArtifactBytes(artifactFiles))
  };
}

function collectRuntimeClosure(rootPath) {
  const visited = new Set();
  const pending = [rootPath];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    if (!filesByPath.has(current)) {
      throw new Error(`Runtime implementation import is absent from dist: ${current}`);
    }
    visited.add(current);
    for (const specifier of relativeModuleSpecifiers(
      requireContent(current).toString('utf8')
    )) {
      const resolved = resolveRelativeModule(current, specifier);
      if (!visited.has(resolved)) pending.push(resolved);
    }
  }
  return [...visited].sort(compareCodeUnits);
}

function relativeModuleSpecifiers(source) {
  const values = new Set();
  const staticPattern = /(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"](\.[^'"]+)['"]/gu;
  const dynamicPattern = /import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/gu;
  for (const pattern of [staticPattern, dynamicPattern]) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) values.add(match[1]);
    }
  }
  return [...values].sort(compareCodeUnits);
}

function resolveRelativeModule(importerPath, specifier) {
  const absolutePath = resolve(runtimeRoot, dirname(importerPath), specifier);
  const relativeToDist = relative(distRoot, absolutePath);
  if (
    relativeToDist === ''
    || relativeToDist === '..'
    || relativeToDist.startsWith(`..${sep}`)
    || isAbsolute(relativeToDist)
    || !relativeToDist.endsWith('.js')
  ) {
    throw new Error(`Tool artifact import escapes Runtime dist: ${importerPath} -> ${specifier}`);
  }
  return `dist/${relativeToDist.split(sep).join('/')}`;
}

function canonicalArtifactBytes(files) {
  const chunks = [Buffer.from(`${TOOL_ARTIFACT_ALGORITHM}\0`, 'utf8')];
  for (const file of files) {
    const content = requireContent(file.path);
    chunks.push(Buffer.from(`${file.path}\0${String(content.byteLength)}\0`, 'utf8'));
    chunks.push(content);
    chunks.push(Buffer.from('\0', 'utf8'));
  }
  return Buffer.concat(chunks);
}

function requireContent(filePath) {
  const content = contentsByPath.get(filePath);
  if (content === undefined) throw new Error(`Runtime build file is missing: ${filePath}`);
  return content;
}

async function listJavaScriptFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const listed = [];
  for (const entry of entries) {
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) {
      listed.push(...await listJavaScriptFiles(absolutePath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.js')) listed.push(absolutePath);
  }
  return listed;
}

async function writeIfChanged(filePath, content) {
  let current;
  try {
    current = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (current !== content) await writeFile(filePath, content, 'utf8');
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

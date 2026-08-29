import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

import {
  skillPackageDigest,
  validateSkillResourcePath
} from './ProductionSkillCatalogSupport.js';
import type {
  ProductionSkillCandidate,
  ProductionSkillDefinition,
  ProductionSkillInvocationPolicy,
  ProductionSkillLayer,
  ProductionSkillResource,
  ProductionSkillResourceDescriptor
} from './ProductionSkillContracts.js';

const MAX_SKILL_BODY_BYTES = 128 * 1024;
const MAX_RESOURCE_BYTES = 1024 * 1024;
const MAX_PACKAGE_BYTES = 4 * 1024 * 1024;
const MAX_RESOURCE_COUNT = 128;
const MAX_RESOURCE_DEPTH = 8;

interface LocalSkillLocator {
  readonly kind: 'local-skill';
  readonly canonicalProviderRoot: string;
  readonly packageRoot: string;
  readonly skillFilePath: string;
}

interface ParsedSkillMetadata {
  readonly name: string;
  readonly description: string;
  readonly invocation: ProductionSkillInvocationPolicy;
}

interface LocalSkillPackageSnapshot {
  readonly body: string;
  readonly metadata: ParsedSkillMetadata;
  readonly resources: readonly ProductionSkillResource[];
  readonly revision: string;
}

export function discoverLocalSkillCandidate(input: {
  readonly canonicalProviderRoot: string;
  readonly candidatePath: string;
  readonly name: string;
  readonly layer: ProductionSkillLayer;
  readonly signal: AbortSignal;
}): ProductionSkillCandidate {
  const packageRoot = realpathSync(path.dirname(input.candidatePath));
  const skillFilePath = realpathSync(input.candidatePath);
  if (
    !isWithin(input.canonicalProviderRoot, packageRoot)
    || !isWithin(packageRoot, skillFilePath)
  ) throw new Error(`skill_path_outside_root:${input.name}`);
  const snapshot = readSkillPackage(packageRoot, skillFilePath, input.name, input.signal);
  if (snapshot.metadata.name !== input.name) throw new Error(`skill_name_mismatch:${input.name}`);
  return Object.freeze({
    name: input.name,
    description: snapshot.metadata.description,
    revision: snapshot.revision,
    layer: input.layer,
    invocation: snapshot.metadata.invocation,
    locator: Object.freeze<LocalSkillLocator>({
      kind: 'local-skill',
      canonicalProviderRoot: input.canonicalProviderRoot,
      packageRoot,
      skillFilePath
    })
  });
}

export function loadLocalSkillDefinition(
  candidate: ProductionSkillCandidate,
  signal: AbortSignal
): ProductionSkillDefinition {
  signal.throwIfAborted();
  const snapshot = readCurrentPackage(candidate, signal);
  assertLocalPackageMatchesCandidate(snapshot, candidate);
  return Object.freeze({
    name: candidate.name,
    description: candidate.description,
    revision: candidate.revision,
    layer: candidate.layer,
    invocation: candidate.invocation,
    body: snapshot.body,
    resources: Object.freeze(snapshot.resources.map(publicResourceDescriptor))
  });
}

export function loadLocalSkillResource(
  candidate: ProductionSkillCandidate,
  relativePath: string,
  signal: AbortSignal
): ProductionSkillResource | undefined {
  signal.throwIfAborted();
  validateSkillResourcePath(relativePath);
  const snapshot = readCurrentPackage(candidate, signal);
  assertLocalPackageMatchesCandidate(snapshot, candidate);
  const resource = snapshot.resources.find((entry) => entry.relativePath === relativePath);
  if (resource === undefined) return undefined;
  signal.throwIfAborted();
  return Object.freeze({
    ...publicResourceDescriptor(resource),
    bytes: new Uint8Array(resource.bytes)
  });
}

function readCurrentPackage(
  candidate: ProductionSkillCandidate,
  signal: AbortSignal
): LocalSkillPackageSnapshot {
  const locator = requireLocalLocator(candidate.locator);
  if (!existsSync(locator.skillFilePath) || !existsSync(locator.packageRoot)) {
    throw new Error('skill_source_unavailable');
  }
  const currentPackageRoot = realpathSync(locator.packageRoot);
  const currentSkillPath = realpathSync(locator.skillFilePath);
  if (
    currentPackageRoot !== locator.packageRoot
    || currentSkillPath !== locator.skillFilePath
    || !isWithin(locator.canonicalProviderRoot, currentPackageRoot)
    || !isWithin(currentPackageRoot, currentSkillPath)
  ) throw new Error('skill_source_unavailable');
  return readSkillPackage(currentPackageRoot, currentSkillPath, candidate.name, signal);
}

function readSkillPackage(
  packageRoot: string,
  skillFilePath: string,
  fallbackName: string,
  signal: AbortSignal
): LocalSkillPackageSnapshot {
  signal.throwIfAborted();
  const body = readBoundedText(skillFilePath, MAX_SKILL_BODY_BYTES, 'skill_file_too_large');
  const metadata = parseMetadata(body, fallbackName);
  const resources: ProductionSkillResource[] = [];
  let packageBytes = Buffer.byteLength(body, 'utf8');

  const visit = (directory: string, depth: number): void => {
    if (depth > MAX_RESOURCE_DEPTH) throw new Error('skill_resource_depth_exceeded');
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const entry of entries) {
      signal.throwIfAborted();
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('skill_resource_symlink_unsupported');
      if (entry.isDirectory()) {
        visit(entryPath, depth + 1);
        continue;
      }
      if (!entry.isFile() || entryPath === skillFilePath) continue;
      const canonicalPath = realpathSync(entryPath);
      if (canonicalPath !== entryPath || !isWithin(packageRoot, canonicalPath)) {
        throw new Error('skill_resource_outside_package');
      }
      const relativePath = path.relative(packageRoot, canonicalPath).split(path.sep).join('/');
      validateSkillResourcePath(relativePath);
      if (resources.length >= MAX_RESOURCE_COUNT) throw new Error('skill_resource_count_exceeded');
      const bytes = readBoundedBytes(canonicalPath, MAX_RESOURCE_BYTES, 'skill_resource_too_large');
      packageBytes += bytes.byteLength;
      if (packageBytes > MAX_PACKAGE_BYTES) throw new Error('skill_package_too_large');
      resources.push(Object.freeze({
        relativePath,
        mediaType: resourceMediaType(relativePath),
        byteLength: bytes.byteLength,
        revision: digestBytes(bytes),
        bytes: new Uint8Array(bytes)
      }));
    }
  };

  visit(packageRoot, 0);
  resources.sort((left, right) => compareCodeUnits(left.relativePath, right.relativePath));
  signal.throwIfAborted();
  return Object.freeze({
    body,
    metadata,
    resources: Object.freeze(resources),
    revision: skillPackageDigest(body, resources)
  });
}

function assertLocalPackageMatchesCandidate(
  snapshot: LocalSkillPackageSnapshot,
  candidate: ProductionSkillCandidate
): void {
  if (
    snapshot.revision !== candidate.revision
    || snapshot.metadata.name !== candidate.name
    || snapshot.metadata.description !== candidate.description
    || snapshot.metadata.invocation.modelInvocable !== candidate.invocation.modelInvocable
    || snapshot.metadata.invocation.userInvocable !== candidate.invocation.userInvocable
  ) throw new Error('skill_source_drifted');
}

function requireLocalLocator(value: unknown): LocalSkillLocator {
  if (
    value === null
    || typeof value !== 'object'
    || (value as Partial<LocalSkillLocator>).kind !== 'local-skill'
    || typeof (value as Partial<LocalSkillLocator>).canonicalProviderRoot !== 'string'
    || typeof (value as Partial<LocalSkillLocator>).packageRoot !== 'string'
    || typeof (value as Partial<LocalSkillLocator>).skillFilePath !== 'string'
  ) throw new Error('skill_locator_invalid');
  return value as LocalSkillLocator;
}

function parseMetadata(body: string, fallbackName: string): ParsedSkillMetadata {
  const normalized = body.replaceAll('\r\n', '\n');
  let frontmatter = '';
  let content = normalized;
  if (normalized.startsWith('---\n')) {
    const end = normalized.indexOf('\n---\n', 4);
    if (end < 0) throw new Error(`skill_frontmatter_invalid:${fallbackName}`);
    frontmatter = normalized.slice(4, end);
    content = normalized.slice(end + 5);
  }
  const fields = new Map<string, string>();
  for (const line of frontmatter.split('\n')) {
    const match = /^([a-z][a-z0-9_-]*):\s*(.+)$/u.exec(line.trim());
    if (match !== null) fields.set(match[1]!, stripQuotes(match[2]!.trim()));
  }
  const name = fields.get('name') ?? fallbackName;
  const description = fields.get('description')
    ?? firstDescription(content)
    ?? `Instructions for ${name}.`;
  if (!/^[a-z][a-z0-9_-]*$/u.test(name)) throw new Error(`skill_metadata_invalid:${fallbackName}`);
  if (description.length === 0 || description.length > 512 || /[\r\n]/u.test(description)) {
    throw new Error(`skill_description_invalid:${fallbackName}`);
  }
  return Object.freeze({
    name,
    description,
    invocation: Object.freeze({
      modelInvocable: !parseBooleanField(fields, 'disable-model-invocation', false),
      userInvocable: parseBooleanField(fields, 'user-invocable', true)
    })
  });
}

function parseBooleanField(fields: ReadonlyMap<string, string>, key: string, fallback: boolean): boolean {
  const value = fields.get(key);
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`skill_boolean_metadata_invalid:${key}`);
}

function publicResourceDescriptor(
  resource: ProductionSkillResourceDescriptor
): ProductionSkillResourceDescriptor {
  return Object.freeze({
    relativePath: resource.relativePath,
    mediaType: resource.mediaType,
    byteLength: resource.byteLength,
    revision: resource.revision
  });
}

function firstDescription(body: string): string | undefined {
  return body.split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && line !== '---' && !line.startsWith('#'))
    ?.slice(0, 512);
}

function stripQuotes(value: string): string {
  return value.length >= 2
    && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ? value.slice(1, -1)
    : value;
}

function readBoundedText(filePath: string, maxBytes: number, errorCode: string): string {
  const content = readBoundedBytes(filePath, maxBytes, errorCode);
  if (content.includes(0)) throw new Error('skill_file_binary');
  return content.toString('utf8');
}

function readBoundedBytes(filePath: string, maxBytes: number, errorCode: string): Buffer {
  const content = readFileSync(filePath);
  if (content.byteLength > maxBytes) throw new Error(errorCode);
  return content;
}

function digestBytes(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function resourceMediaType(relativePath: string): string {
  switch (path.posix.extname(relativePath).toLowerCase()) {
    case '.md': return 'text/markdown';
    case '.txt': return 'text/plain';
    case '.json': return 'application/json';
    case '.yaml':
    case '.yml': return 'application/yaml';
    case '.js':
    case '.mjs':
    case '.cjs': return 'text/javascript';
    case '.ts':
    case '.tsx': return 'text/typescript';
    case '.py': return 'text/x-python';
    case '.sh': return 'text/x-shellscript';
    case '.ps1': return 'text/x-powershell';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.pdf': return 'application/pdf';
    default: return 'application/octet-stream';
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  AgentToolImplementationArtifactBytesV1
} from '../../control/ports/AgentToolExecution.js';

const ARTIFACT_ALGORITHM = 'ariadne-tool-module-closure-v1';
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MAX_ARTIFACT_FILES = 2_000;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

interface ToolArtifactFileRecord {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
}

interface ToolArtifactModuleRecord {
  readonly module: string;
  readonly files: readonly ToolArtifactFileRecord[];
  readonly artifactDigest: string;
}

interface ToolArtifactManifestV1 {
  readonly schemaVersion: 1;
  readonly algorithm: typeof ARTIFACT_ALGORITHM;
  readonly modules: readonly ToolArtifactModuleRecord[];
}

/**
 * Verifies the build-generated first-party Tool implementation closure against
 * the exact JavaScript bytes that this Runtime package will execute.
 */
export class FirstPartyToolArtifactAuthority {
  private readonly runtimeRoot: string;
  private readonly modules: ReadonlyMap<string, Uint8Array>;

  public constructor(runtimeRoot: string) {
    this.runtimeRoot = path.resolve(runtimeRoot);
    this.modules = this.loadAndVerify();
  }

  public implementationFor(moduleUrl: string): AgentToolImplementationArtifactBytesV1 {
    const modulePath = this.modulePath(moduleUrl);
    const artifact = this.modules.get(modulePath);
    if (artifact === undefined) {
      throw new Error(`first_party_tool_artifact_module_unregistered:${modulePath}`);
    }
    return Object.freeze({
      provider: artifact,
      normalizer: artifact,
      preparedValidator: artifact,
      execute: artifact
    });
  }

  public verifiedModules(): readonly string[] {
    return Object.freeze([...this.modules.keys()]);
  }

  private loadAndVerify(): ReadonlyMap<string, Uint8Array> {
    const manifestPath = path.join(
      this.runtimeRoot,
      'config',
      'first-party-tool-artifacts.json'
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (cause) {
      throw new Error('first_party_tool_artifact_manifest_unavailable', { cause });
    }
    const manifest = parseManifest(parsed);
    const modules = new Map<string, Uint8Array>();
    for (const record of manifest.modules) {
      const artifact = this.verifyModule(record);
      modules.set(record.module, artifact);
    }
    return modules;
  }

  private verifyModule(record: ToolArtifactModuleRecord): Uint8Array {
    const chunks: Buffer[] = [Buffer.from(`${ARTIFACT_ALGORITHM}\0`, 'utf8')];
    let totalBytes = chunks[0]!.byteLength;
    for (const file of record.files) {
      const absolutePath = resolveRuntimeFile(this.runtimeRoot, file.path);
      let content: Buffer;
      try {
        content = readFileSync(absolutePath);
      } catch (cause) {
        throw new Error(`first_party_tool_artifact_file_unavailable:${file.path}`, {
          cause
        });
      }
      if (
        content.byteLength !== file.byteLength
        || digest(content) !== file.sha256
      ) {
        throw new Error(`first_party_tool_artifact_file_drift:${file.path}`);
      }
      const header = Buffer.from(
        `${file.path}\0${String(content.byteLength)}\0`,
        'utf8'
      );
      chunks.push(header, content, Buffer.from('\0', 'utf8'));
      totalBytes += header.byteLength + content.byteLength + 1;
      if (totalBytes > MAX_ARTIFACT_BYTES) {
        throw new Error(`first_party_tool_artifact_too_large:${record.module}`);
      }
    }
    const artifact = Buffer.concat(chunks);
    if (digest(artifact) !== record.artifactDigest) {
      throw new Error(`first_party_tool_artifact_bundle_drift:${record.module}`);
    }
    return artifact;
  }

  private modulePath(moduleUrl: string): string {
    let absolutePath: string;
    try {
      absolutePath = fileURLToPath(moduleUrl);
    } catch (cause) {
      throw new Error('first_party_tool_artifact_module_url_invalid', { cause });
    }
    const sourceRelative = containedRelative(
      path.join(this.runtimeRoot, 'src'),
      absolutePath
    );
    if (sourceRelative !== null && sourceRelative.endsWith('.ts')) {
      return `dist/${sourceRelative.slice(0, -3).replaceAll('\\', '/')}.js`;
    }
    const distRelative = containedRelative(
      path.join(this.runtimeRoot, 'dist'),
      absolutePath
    );
    if (distRelative !== null && distRelative.endsWith('.js')) {
      return `dist/${distRelative.replaceAll('\\', '/')}`;
    }
    throw new Error('first_party_tool_artifact_module_outside_runtime');
  }
}

let productionAuthority: FirstPartyToolArtifactAuthority | undefined;

export function firstPartyToolImplementationArtifacts(
  moduleUrl: string
): AgentToolImplementationArtifactBytesV1 {
  productionAuthority ??= new FirstPartyToolArtifactAuthority(runtimeRoot());
  return productionAuthority.implementationFor(moduleUrl);
}

export function verifyFirstPartyToolArtifactManifest(): readonly string[] {
  return new FirstPartyToolArtifactAuthority(runtimeRoot()).verifiedModules();
}

function parseManifest(value: unknown): ToolArtifactManifestV1 {
  if (!isExactRecord(value, ['schemaVersion', 'algorithm', 'modules'])) {
    throw new Error('first_party_tool_artifact_manifest_invalid');
  }
  if (
    value.schemaVersion !== 1
    || value.algorithm !== ARTIFACT_ALGORITHM
    || !Array.isArray(value.modules)
    || value.modules.length === 0
    || value.modules.length > 100
  ) throw new Error('first_party_tool_artifact_manifest_invalid');

  const modules = value.modules.map((entry) => parseModule(entry));
  if (!strictlySortedUnique(modules.map((entry) => entry.module))) {
    throw new Error('first_party_tool_artifact_modules_not_canonical');
  }
  return { schemaVersion: 1, algorithm: ARTIFACT_ALGORITHM, modules };
}

function parseModule(value: unknown): ToolArtifactModuleRecord {
  if (!isExactRecord(value, ['module', 'files', 'artifactDigest'])) {
    throw new Error('first_party_tool_artifact_module_invalid');
  }
  if (
    typeof value.module !== 'string'
    || !isCanonicalRuntimeJavaScriptPath(value.module)
    || !Array.isArray(value.files)
    || value.files.length === 0
    || value.files.length > MAX_ARTIFACT_FILES
    || typeof value.artifactDigest !== 'string'
    || !DIGEST_PATTERN.test(value.artifactDigest)
  ) throw new Error('first_party_tool_artifact_module_invalid');
  const files = value.files.map((entry) => parseFile(entry));
  if (
    !strictlySortedUnique(files.map((entry) => entry.path))
    || !files.some((entry) => entry.path === value.module)
  ) throw new Error('first_party_tool_artifact_files_not_canonical');
  return {
    module: value.module,
    files,
    artifactDigest: value.artifactDigest
  };
}

function parseFile(value: unknown): ToolArtifactFileRecord {
  if (!isExactRecord(value, ['path', 'byteLength', 'sha256'])) {
    throw new Error('first_party_tool_artifact_file_invalid');
  }
  const byteLength = value.byteLength;
  if (
    typeof value.path !== 'string'
    || !isCanonicalRuntimeJavaScriptPath(value.path)
    || typeof byteLength !== 'number'
    || !Number.isSafeInteger(byteLength)
    || byteLength < 1
    || byteLength > MAX_ARTIFACT_BYTES
    || typeof value.sha256 !== 'string'
    || !DIGEST_PATTERN.test(value.sha256)
  ) throw new Error('first_party_tool_artifact_file_invalid');
  return {
    path: value.path,
    byteLength,
    sha256: value.sha256
  };
}

function resolveRuntimeFile(runtimeRootPath: string, requested: string): string {
  const absolutePath = path.resolve(runtimeRootPath, requested);
  if (containedRelative(path.join(runtimeRootPath, 'dist'), absolutePath) === null) {
    throw new Error(`first_party_tool_artifact_path_outside_dist:${requested}`);
  }
  return absolutePath;
}

function isCanonicalRuntimeJavaScriptPath(value: string): boolean {
  return value.startsWith('dist/')
    && value.endsWith('.js')
    && !value.includes('\\')
    && path.posix.normalize(value) === value;
}

function containedRelative(parent: string, candidate: string): string | null {
  const value = path.relative(path.resolve(parent), path.resolve(candidate));
  const isContained = value === '' || (
    !value.startsWith(`..${path.sep}`)
    && value !== '..'
    && !path.isAbsolute(value)
  );
  return isContained ? value : null;
}

function isExactRecord(
  value: unknown,
  keys: readonly string[]
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length
    && actual.every((key) => typeof key === 'string' && keys.includes(key));
}

function strictlySortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function digest(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function runtimeRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

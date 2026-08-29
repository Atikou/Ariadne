import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, lstat, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { SpeechVoiceSummary, VoicePackInstallResult } from '@shared/contract';

const voiceManifestSchema = z.object({
  schemaVersion: z.literal(1),
  engine: z.literal('sherpa-onnx-vits'),
  voiceId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u),
  version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
  displayName: z.string().trim().min(1).max(128),
  languages: z.array(z.string().trim().min(2).max(32)).min(1).max(16),
  sampleRate: z.number().int().min(8_000).max(192_000),
  speakerId: z.number().int().nonnegative().default(0),
  files: z.object({
    model: safeRelativePathSchema(),
    config: safeRelativePathSchema(),
    tokens: safeRelativePathSchema(),
    lexicon: safeRelativePathSchema().optional(),
    dataDir: safeRelativePathSchema().optional(),
    sample: safeRelativePathSchema(),
    modelCard: safeRelativePathSchema(),
    ruleFsts: z.array(safeRelativePathSchema()).max(16).optional()
  }).strict(),
  license: z.object({
    name: z.string().trim().min(1).max(128),
    url: z.string().url().optional(),
    redistributionAllowed: z.boolean()
  }).strict()
}).strict();

export type VoicePackManifest = z.infer<typeof voiceManifestSchema>;

export class VoicePackManager {
  private operation: Promise<unknown> = Promise.resolve();

  constructor(private readonly moduleRoot: string) {}

  install(
    archivePath: string,
    testCandidate: (root: string, manifest: VoicePackManifest) => Promise<void>
  ): Promise<VoicePackInstallResult> {
    return this.serialized(() => this.installInternal(archivePath, testCandidate));
  }

  async list(activeVoiceId: string | null, activeVoiceVersion: string | null): Promise<SpeechVoiceSummary[]> {
    const root = join(this.moduleRoot, 'voices');
    const catalogs = ['builtin', 'installed'];
    const voices: SpeechVoiceSummary[] = [];
    for (const catalog of catalogs) {
      const catalogRoot = join(root, catalog);
      for (const voiceId of await directoryNames(catalogRoot)) {
        for (const version of await directoryNames(join(catalogRoot, voiceId))) {
          try {
            const manifest = await readVoiceManifest(join(catalogRoot, voiceId, version));
            voices.push(toSummary(
              manifest,
              activeVoiceId === manifest.voiceId && activeVoiceVersion === manifest.version
            ));
          } catch {
            // An incomplete directory is not an installed voice.
          }
        }
      }
    }
    return voices.sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  async resolveVoice(voiceId: string, version: string): Promise<{ root: string; manifest: VoicePackManifest }> {
    for (const catalog of ['installed', 'builtin']) {
      const root = join(this.moduleRoot, 'voices', catalog, voiceId, version);
      try {
        return { root, manifest: await readVoiceManifest(root) };
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    throw new Error('speech_voice_not_installed');
  }

  private async installInternal(
    archivePath: string,
    testCandidate: (root: string, manifest: VoicePackManifest) => Promise<void>
  ): Promise<VoicePackInstallResult> {
    if (!isAbsolute(archivePath) || extname(archivePath).toLowerCase() !== '.avp') {
      throw new Error('speech_voice_archive_invalid');
    }
    const stagingParent = join(this.moduleRoot, 'voices', '.staging');
    const stagingRoot = join(stagingParent, `${Date.now()}-${process.pid}`);
    await mkdir(stagingRoot, { recursive: true });
    try {
      const entries = await listArchiveEntries(archivePath);
      for (const entry of entries) assertSafeRelativePath(entry);
      await extractArchive(archivePath, stagingRoot);
      const packRoot = await locatePackRoot(stagingRoot);
      await assertSafeExtractedTree(packRoot);
      const manifest = await readVoiceManifest(packRoot);
      await verifyChecksums(packRoot);
      await verifyManifestFiles(packRoot, manifest);
      await testCandidate(packRoot, manifest);

      const target = join(this.moduleRoot, 'voices', 'installed', manifest.voiceId, manifest.version);
      await mkdir(dirname(target), { recursive: true });
      if (await exists(target)) throw new Error('speech_voice_version_already_installed');
      await rename(packRoot, target);
      return {
        installed: true,
        voice: toSummary(manifest, false),
        detail: `Installed ${manifest.displayName} ${manifest.version}.`
      };
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }
}

function safeRelativePathSchema(): z.ZodString {
  return z.string().trim().min(1).max(2_048).refine((value) => {
    try { assertSafeRelativePath(value); return true; } catch { return false; }
  }, 'Voice pack path must remain inside the pack.');
}

function assertSafeRelativePath(value: string): void {
  const normalized = value.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) {
    throw new Error('speech_voice_path_unsafe');
  }
  if (normalized.split('/').some((part) => part === '..' || part === '')) {
    throw new Error('speech_voice_path_unsafe');
  }
}

async function listArchiveEntries(path: string): Promise<string[]> {
  const output = await runTar(['-tf', path]);
  return output.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean);
}

async function extractArchive(path: string, destination: string): Promise<void> {
  await runTar(['-xf', path, '-C', destination]);
}

function runTar(args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('tar.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolvePromise(stdout)
      : reject(new Error(`speech_voice_archive_extract_failed:${stderr.slice(0, 500)}`)));
  });
}

async function locatePackRoot(stagingRoot: string): Promise<string> {
  const matches: string[] = [];
  await walk(stagingRoot, async (path, stats) => {
    if (stats.isFile() && basename(path) === 'voice.json') matches.push(dirname(path));
  });
  if (matches.length !== 1) throw new Error('speech_voice_manifest_count_invalid');
  return matches[0]!;
}

async function assertSafeExtractedTree(root: string): Promise<void> {
  const forbidden = new Set(['.bat', '.cmd', '.com', '.dll', '.exe', '.msi', '.ps1', '.scr']);
  await walk(root, async (path, stats) => {
    if (stats.isSymbolicLink()) throw new Error('speech_voice_symlink_forbidden');
    if (stats.isFile() && forbidden.has(extname(path).toLowerCase())) {
      throw new Error('speech_voice_executable_forbidden');
    }
    assertContained(root, path);
  });
}

async function readVoiceManifest(root: string): Promise<VoicePackManifest> {
  return voiceManifestSchema.parse(JSON.parse(await readFile(join(root, 'voice.json'), 'utf8')));
}

async function verifyManifestFiles(root: string, manifest: VoicePackManifest): Promise<void> {
  const files = manifest.files;
  const required = [files.model, files.config, files.tokens, files.sample, files.modelCard];
  if (files.lexicon) required.push(files.lexicon);
  if (files.dataDir) required.push(files.dataDir);
  if (files.ruleFsts) required.push(...files.ruleFsts);
  for (const item of required) {
    const path = resolve(root, item);
    assertContained(root, path);
    await access(path);
  }
}

async function verifyChecksums(root: string): Promise<void> {
  const checksums = z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/u)).parse(
    JSON.parse(await readFile(join(root, 'checksums.json'), 'utf8'))
  );
  for (const [relativePath, expected] of Object.entries(checksums)) {
    assertSafeRelativePath(relativePath);
    const path = resolve(root, relativePath);
    assertContained(root, path);
    const stats = await lstat(path);
    if (!stats.isFile()) throw new Error('speech_voice_checksum_target_invalid');
    const actual = await sha256(path);
    if (actual !== expected) throw new Error(`speech_voice_checksum_mismatch:${relativePath}`);
  }
  for (const required of ['voice.json', 'model.onnx', 'model.onnx.json', 'tokens.txt', 'sample.wav', 'MODEL_CARD.md']) {
    if (!(required in checksums)) throw new Error(`speech_voice_checksum_missing:${required}`);
  }
}

function sha256(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

async function walk(root: string, visit: (path: string, stats: Awaited<ReturnType<typeof lstat>>) => Promise<void>): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const stats = await lstat(path);
    await visit(path, stats);
    if (stats.isDirectory()) await walk(path, visit);
  }
}

async function directoryNames(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function assertContained(root: string, path: string): void {
  const rel = relative(resolve(root), resolve(path));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('speech_voice_path_unsafe');
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch (error) { if (isMissing(error)) return false; throw error; }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function toSummary(manifest: VoicePackManifest, active: boolean): SpeechVoiceSummary {
  return {
    voiceId: manifest.voiceId,
    version: manifest.version,
    displayName: manifest.displayName,
    languages: [...manifest.languages],
    sampleRate: manifest.sampleRate,
    active
  };
}

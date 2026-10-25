import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, opendir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { BACKUP_FORMAT, MAX_BACKUP_MANIFEST_BYTES, backupManifestSchema, parseBackupManifest,
  type BackupManifest, type BackupScope } from './backup-manifest';
import { backupObjectSealSchema, sealBackupFile, unsealBackupFile, type BackupObjectSeal } from './backup-object-seal';
import type { BackupKeyProtector } from '../runtime/windows-backup-key-protector';

const MAX_HEADER_BYTES = 24 * 1024 * 1024;
const base64 = (bytes: number) => z.string().refine(value => Buffer.from(value, 'base64').length === bytes
  && Buffer.from(value, 'base64').toString('base64') === value);
const headerSchema = z.object({ format: z.literal(BACKUP_FORMAT), version: z.literal(1), backupId: z.uuid(),
  wrappedKey: z.string().min(1).max(16_384), manifest: z.object({ algorithm: z.literal('AES-256-GCM'),
    nonce: base64(12), tag: base64(16), ciphertext: z.string().min(1).max(Math.ceil(MAX_BACKUP_MANIFEST_BYTES / 3) * 4)
      .refine(value => Buffer.from(value, 'base64').toString('base64') === value) }).strict() }).strict();
const sealedManifestSchema = z.object({ manifest: backupManifestSchema,
  seals: z.array(backupObjectSealSchema).max(20_000) }).strict().refine(value => value.seals.length === value.manifest.files.length);
export type BackupSnapshotRoots = Readonly<Record<BackupScope, string>>;
export interface PublishedBackup { backupId: string; directory: string; files: number; bytes: number }
export interface UnpackedBackup { manifest: BackupManifest; stage: string; roots: BackupSnapshotRoots }

/** Main's caller derives roots from its own snapshot boundary, never Renderer
 * input. Only the authenticated closed inventory decides object identities. */
export async function publishBackupBundle(input: { manifest: BackupManifest; snapshotRoots: BackupSnapshotRoots;
  destinationParent: string; forbiddenRoots: readonly string[]; protector: BackupKeyProtector;
  signal?: AbortSignal }): Promise<PublishedBackup> {
  const manifest = parseBackupManifest(JSON.stringify(input.manifest));
  const parent = await canonicalDirectory(input.destinationParent);
  for (const root of [...Object.values(input.snapshotRoots), ...input.forbiddenRoots]) {
    if (within(await canonicalDirectory(root), parent)) throw new Error('backup_destination_inside_source');
  }
  const stage = join(parent, '.ariadne-backup-' + manifest.backupId + '.tmp');
  const destination = join(parent, 'Ariadne-backup-' + manifest.backupId);
  const key = randomBytes(32); let stageCreated = false;
  try {
    throwIfCancelled(input.signal);
    await mkdir(stage); stageCreated = true; await mkdir(join(stage, 'objects'));
    const wrappedKey = await input.protector.protect(key), seals: BackupObjectSeal[] = [];
    for (let index = 0; index < manifest.files.length; index++) {
      throwIfCancelled(input.signal);
      const file = manifest.files[index]!;
      const source = await ownedFilePath(input.snapshotRoots[file.scope], file.path);
      seals.push(await sealBackupFile(source, join(stage, 'objects', objectName(index)), key, manifest.backupId, file));
    }
    const plaintext = Buffer.from(JSON.stringify(sealedManifestSchema.parse({ manifest, seals })));
    try {
      if (plaintext.length > MAX_BACKUP_MANIFEST_BYTES) throw new Error('backup_manifest_capacity_exceeded');
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(manifestAad(manifest.backupId));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const header = headerSchema.parse({ format: BACKUP_FORMAT, version: 1, backupId: manifest.backupId, wrappedKey,
        manifest: { algorithm: 'AES-256-GCM', nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
          ciphertext: ciphertext.toString('base64') } });
      await writeExclusiveSynced(join(stage, 'header.json'), Buffer.from(JSON.stringify(header) + '\n'));
    } finally { plaintext.fill(0); }
    throwIfCancelled(input.signal);
    // The fully flushed directory is published by one same-volume rename.
    // Existing destinations are never opened or merged.
    if (await exists(destination)) throw new Error('backup_destination_exists');
    await rename(stage, destination); stageCreated = false;
    return { backupId: manifest.backupId, directory: destination, files: manifest.files.length,
      bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0) };
  } finally {
    key.fill(0);
    if (stageCreated) await removeOwnedBackupStage(parent, stage, '.ariadne-backup-' + manifest.backupId + '.tmp');
  }
}

/** Authentication and extraction happen in a new private root. This does not
 * authorize replacing live data: original schema/key/Runtime validation and a
 * recoverable owner shutdown/switch must subsequently approve that operation. */
export async function unpackBackupBundle(input: { directory: string; stagingParent: string;
  forbiddenRoots: readonly string[]; protector: BackupKeyProtector; signal?: AbortSignal }): Promise<UnpackedBackup> {
  const directory = await canonicalDirectory(input.directory), parent = await canonicalDirectory(input.stagingParent);
  for (const root of input.forbiddenRoots) {
    if (within(await canonicalDirectory(root), parent)) throw new Error('restore_stage_inside_source');
  }
  const headerPath = await ownedFilePath(directory, 'header.json');
  const raw = await readBoundedFile(headerPath, MAX_HEADER_BYTES);
  const header = headerSchema.parse(JSON.parse(raw.toString('utf8')));
  const key = await input.protector.unprotect(header.wrappedKey);
  let stage: string | undefined;
  try {
    throwIfCancelled(input.signal);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.manifest.nonce, 'base64'));
    decipher.setAAD(manifestAad(header.backupId)); decipher.setAuthTag(Buffer.from(header.manifest.tag, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(header.manifest.ciphertext, 'base64')), decipher.final()]);
    let sealed: z.infer<typeof sealedManifestSchema>;
    try {
      if (plaintext.length > MAX_BACKUP_MANIFEST_BYTES) throw new Error('backup_manifest_capacity_exceeded');
      sealed = sealedManifestSchema.parse(JSON.parse(plaintext.toString('utf8')));
      parseBackupManifest(JSON.stringify(sealed.manifest));
      if (sealed.manifest.backupId !== header.backupId) throw new Error('backup_manifest_identity_invalid');
    } finally { plaintext.fill(0); }
    await exactDirectoryEntries(directory, new Set(['header.json', 'objects']));
    const objects = await ownedDirectoryPath(directory, 'objects');
    await exactDirectoryEntries(objects, new Set(sealed.manifest.files.map((_file, index) => objectName(index))));
    const proposed = join(parent, '.ariadne-restore-' + randomUUID() + '.tmp');
    await mkdir(proposed); stage = proposed;
    const roots: BackupSnapshotRoots = { userData: join(stage, 'userData'), runtime: join(stage, 'runtime'), sessionData: join(stage, 'sessionData') };
    for (const root of Object.values(roots)) await mkdir(root);
    for (let index = 0; index < sealed.manifest.files.length; index++) {
      throwIfCancelled(input.signal);
      const file = sealed.manifest.files[index]!, source = await ownedFilePath(objects, objectName(index));
      const destination = join(roots[file.scope], file.path);
      await mkdir(dirname(destination), { recursive: true });
      await ownedDirectoryPath(roots[file.scope], relative(roots[file.scope], dirname(destination)) || '.');
      await unsealBackupFile(source, destination, key, header.backupId, file, sealed.seals[index]!);
    }
    const completed = stage; stage = undefined;
    return { manifest: sealed.manifest, stage: completed, roots };
  } finally {
    key.fill(0);
    if (stage) await removeOwnedBackupStage(parent, stage, basename(stage));
  }
}

function manifestAad(backupId: string): Buffer { return Buffer.from(JSON.stringify([BACKUP_FORMAT, 1, backupId, 'manifest'])); }
function objectName(index: number): string { return String(index).padStart(5, '0') + '.bin'; }
function throwIfCancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new Error('backup_cancelled'); }
function within(root: string, path: string): boolean {
  const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}
async function canonicalDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('backup_root_invalid');
  const named = await lstat(path);
  if (!named.isDirectory() || named.isSymbolicLink()) throw new Error('backup_root_invalid');
  return realpath(path);
}
async function ownedDirectoryPath(root: string, path: string): Promise<string> {
  const canonical = await canonicalDirectory(root), destination = resolve(canonical, path);
  if (!within(canonical, destination)) throw new Error('backup_owned_path_invalid');
  let current = canonical;
  const rel = relative(canonical, destination);
  for (const part of rel ? rel.split(sep) : []) {
    current = join(current, part); const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('backup_owned_directory_invalid');
  }
  return destination;
}
async function ownedFilePath(root: string, path: string): Promise<string> {
  const parent = await ownedDirectoryPath(root, dirname(path)), destination = join(parent, basename(path));
  const entry = await lstat(destination);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('backup_owned_file_invalid');
  return destination;
}
async function exactDirectoryEntries(path: string, expected: ReadonlySet<string>): Promise<void> {
  const found = new Set<string>(), directory = await opendir(path);
  for await (const entry of directory) {
    if (!expected.has(entry.name) || found.has(entry.name) || entry.isSymbolicLink()) throw new Error('backup_inventory_invalid');
    found.add(entry.name);
  }
  if (found.size !== expected.size) throw new Error('backup_inventory_invalid');
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false; throw error; }
}
async function writeExclusiveSynced(path: string, bytes: Buffer): Promise<void> {
  const file = await open(path, 'wx', 0o600); try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
async function readBoundedFile(path: string, limit: number): Promise<Buffer> {
  const named = await lstat(path), file = await open(path, 'r');
  try {
    const opened = await file.stat();
    if (!opened.isFile() || named.isSymbolicLink() || opened.ino !== named.ino || opened.dev !== named.dev
      || opened.size !== named.size || opened.size > limit) throw new Error('backup_header_invalid');
    const output = Buffer.alloc(opened.size); let count = 0;
    while (count < output.length) {
      const result = await file.read(output, count, Math.min(128 * 1024, output.length - count), null);
      if (result.bytesRead === 0) throw new Error('backup_header_invalid'); count += result.bytesRead;
    }
    const probe = Buffer.alloc(1), extra = await file.read(probe, 0, 1, null), after = await file.stat(), final = await lstat(path);
    if (extra.bytesRead || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || final.isSymbolicLink()
      || final.ino !== opened.ino || final.dev !== opened.dev) throw new Error('backup_header_invalid');
    return output;
  } finally { await file.close(); }
}
export async function removeOwnedBackupStage(parent: string, stage: string, name: string): Promise<void> {
  const canonical = await canonicalDirectory(parent), expected = join(canonical, name);
  if (!/^\.ariadne-(backup|restore|validation)-[0-9a-f-]{36}\.tmp$/u.test(name) || resolve(stage) !== expected
    || dirname(resolve(stage)) !== canonical || await canonicalDirectory(stage) !== expected) throw new Error('backup_cleanup_identity_invalid');
  await rm(expected, { recursive: true, force: false });
}

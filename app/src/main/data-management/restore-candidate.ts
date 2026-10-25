import { createHash } from 'node:crypto';
import { lstat, mkdir, open, opendir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { UnpackedBackup } from './backup-bundle';
import { MAX_BACKUP_MANIFEST_BYTES, parseBackupManifest, type BackupManifest } from './backup-manifest';
import { copySnapshotFile, digestSnapshotFile } from './snapshot-file';
import { dataRootCandidateName } from './data-root-switch-journal';
import type { ElectronBackupValidationResponse } from '../runtime/electron-backup-validation-contract';

type Validation = Extract<ElectronBackupValidationResponse['outcome'], { ok: true }>;
export interface VerifiedRestoreCandidate { candidate: string; inventorySha256: string }

/** Reassemble only authenticated, validated owner files into a new sibling of
 * the final profile. Cross-volume backup locations therefore never turn the
 * final profile switch into a recursive copy of live data. */
export async function buildVerifiedRestoreCandidate(input: { unpacked: UnpackedBackup; validation: Validation;
  dataRoot: string; operationId: string; signal?: AbortSignal }): Promise<VerifiedRestoreCandidate> {
  const manifest = parseBackupManifest(JSON.stringify(input.unpacked.manifest));
  if (!input.validation.ok || !('validation' in input.validation.runtime) || input.validation.runtime.validation !== 'current-recovery'
    || input.validation.checkedPrivateFiles !== manifest.files.filter(file => file.scope === 'userData').length
    || JSON.stringify(Object.entries(input.validation.runtime.storageSchemas).sort()) !== JSON.stringify(Object.entries(manifest.boundary.storageSchemas).sort()))
    throw new Error('restore_validation_inventory_mismatch');
  if (!isAbsolute(input.dataRoot)) throw new Error('restore_root_invalid');
  const parent = await realpath(dirname(input.dataRoot));
  const candidate = join(parent, dataRootCandidateName(basename(input.dataRoot), input.operationId));
  await mkdir(candidate);
  // Once admitted, failed candidates are retained as evidence. They cannot be
  // installed without a complete receipt and a successful final digest audit.
  for (const file of manifest.files) {
    if (input.signal?.aborted) throw new Error('restore_cancelled');
    const sourceRoot = input.unpacked.roots[file.scope], source = resolve(sourceRoot, file.path);
    if (await realpath(source) !== source || !(await lstat(source)).isFile()) throw new Error('restore_snapshot_file_alias');
    const destination = candidateFile(candidate, file.scope, file.path);
    await mkdir(dirname(destination), { recursive: true });
    const copied = await copySnapshotFile(source, destination);
    if (copied.bytes !== file.bytes || copied.sha256 !== file.sha256) throw new Error('restore_candidate_digest_mismatch');
  }
  const bytes = Buffer.from(JSON.stringify(manifest) + '\n'), inventorySha256 = createHash('sha256').update(bytes).digest('hex');
  const receipt = await open(candidateReceiptPath(candidate), 'wx', 0o600);
  try { await receipt.writeFile(bytes); await receipt.sync(); } finally { await receipt.close(); }
  await verifyRestoreCandidate(candidate, manifest.backupId, inventorySha256);
  return { candidate, inventorySha256 };
}

/** The isolated validator has checked the actual schemas and protected bodies.
 * This last audit confirms that those exact bytes survived candidate assembly
 * and remained unchanged until the old process exited. */
export async function verifyRestoreCandidate(candidate: string, backupId: string, inventorySha256: string, receiptCandidate = candidate): Promise<void> {
  if (!isAbsolute(candidate) || await realpath(candidate) !== candidate || (await lstat(candidate)).isSymbolicLink())
    throw new Error('restore_candidate_alias');
  if (dirname(receiptCandidate) !== dirname(candidate)) throw new Error('restore_candidate_receipt_location');
  const receiptPath = candidateReceiptPath(receiptCandidate), metadata = await digestSnapshotFile(receiptPath);
  if (metadata.bytes > MAX_BACKUP_MANIFEST_BYTES || metadata.sha256 !== inventorySha256) throw new Error('restore_candidate_receipt_changed');
  const file = await open(receiptPath, 'r');
  let manifest: BackupManifest;
  try {
    const bytes = Buffer.alloc(metadata.bytes), extra = Buffer.alloc(1); let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, Math.min(128 * 1024, bytes.length - offset), offset);
      if (!read.bytesRead) throw new Error('restore_candidate_receipt_changed'); offset += read.bytesRead;
    }
    if ((await file.read(extra, 0, 1, offset)).bytesRead || createHash('sha256').update(bytes).digest('hex') !== inventorySha256)
      throw new Error('restore_candidate_receipt_changed');
    manifest = parseBackupManifest(bytes.toString('utf8'));
  } finally { await file.close(); }
  if (manifest.backupId !== backupId) throw new Error('restore_candidate_backup_identity');
  const directories = new Map<string, Set<string>>(); directories.set(candidate, new Set());
  for (const entry of manifest.files) {
    const path = candidateFile(candidate, entry.scope, entry.path);
    let child = path;
    while (child !== candidate) {
      const parent = dirname(child); let children = directories.get(parent);
      if (!children) { children = new Set(); directories.set(parent, children); }
      children.add(basename(child)); child = parent;
    }
    const digest = await digestSnapshotFile(path);
    if (digest.bytes !== entry.bytes || digest.sha256 !== entry.sha256) throw new Error('restore_candidate_digest_mismatch');
  }
  for (const [directory, expected] of directories) {
    const named = await lstat(directory);
    if (!named.isDirectory() || named.isSymbolicLink() || await realpath(directory) !== directory) throw new Error('restore_candidate_directory_alias');
    const found = new Set<string>(), opened = await opendir(directory);
    for await (const entry of opened) {
      if (entry.isSymbolicLink() || !expected.has(entry.name) || found.has(entry.name)) throw new Error('restore_candidate_inventory_changed');
      found.add(entry.name);
    }
    if (found.size !== expected.size) throw new Error('restore_candidate_inventory_changed');
  }
}
function candidateFile(candidate: string, scope: 'runtime' | 'userData' | 'sessionData', path: string): string {
  return scope === 'runtime' ? resolve(candidate, 'runtime', path) : resolve(candidate, path);
}
function candidateReceiptPath(candidate: string): string { return candidate + '.inventory.json'; }

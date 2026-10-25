import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { lstat, open, unlink } from 'node:fs/promises';
import { z } from 'zod';
import { BACKUP_FORMAT, validateBackupFileEntry, type BackupFileEntry } from './backup-manifest';

const base64Bytes = (bytes: number) => z.string().refine(value =>
  Buffer.from(value, 'base64').length === bytes && Buffer.from(value, 'base64').toString('base64') === value);
export const backupObjectSealSchema = z.object({ algorithm: z.literal('AES-256-GCM'),
  nonce: base64Bytes(12), tag: base64Bytes(16), ciphertextSha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
export type BackupObjectSeal = z.infer<typeof backupObjectSealSchema>;

function associatedData(backupId: string, entry: BackupFileEntry): Buffer {
  z.uuid().parse(backupId);
  const metadata = validateBackupFileEntry(entry);
  return Buffer.from(JSON.stringify([BACKUP_FORMAT, 1, backupId, metadata.scope, metadata.path,
    metadata.kind, metadata.bytes, metadata.sha256, metadata.sqlite]), 'utf8');
}

/** Copies only files in the caller's frozen, validated inventory. This codec is
 * not a path authorization interface; Main owns both snapshot and destinations.
 * Object authentication binds every byte to its backup, source identity and digest. */
export async function sealBackupFile(source: string, destination: string, key: Buffer,
  backupId: string, entry: BackupFileEntry): Promise<BackupObjectSeal> {
  if (key.length !== 32) throw new Error('backup_data_key_invalid');
  const aad = associatedData(backupId, entry), nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(aad);
  const plaintextHash = createHash('sha256'), ciphertextHash = createHash('sha256');
  let count = 0;
  await transformFile(source, destination, entry.bytes, async (chunk, output) => {
    plaintextHash.update(chunk); count += chunk.length;
    const encrypted = cipher.update(chunk); ciphertextHash.update(encrypted); await output.writeFile(encrypted);
  }, async output => {
    const final = cipher.final(); ciphertextHash.update(final); await output.writeFile(final);
    if (count !== entry.bytes || plaintextHash.digest('hex') !== entry.sha256) throw new Error('backup_source_digest_changed');
  });
  return { algorithm: 'AES-256-GCM', nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
    ciphertextSha256: ciphertextHash.digest('hex') };
}

export async function unsealBackupFile(source: string, destination: string, key: Buffer, backupId: string,
  entry: BackupFileEntry, rawSeal: BackupObjectSeal): Promise<void> {
  if (key.length !== 32) throw new Error('backup_data_key_invalid');
  const aad = associatedData(backupId, entry), seal = backupObjectSealSchema.parse(rawSeal);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(seal.nonce, 'base64'));
  decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(seal.tag, 'base64'));
  const ciphertextHash = createHash('sha256'), plaintextHash = createHash('sha256'); let count = 0;
  try {
    await transformFile(source, destination, entry.bytes, async (chunk, output) => {
      ciphertextHash.update(chunk);
      const plaintext = decipher.update(chunk); count += plaintext.length; plaintextHash.update(plaintext);
      try { await output.writeFile(plaintext); } finally { plaintext.fill(0); }
    }, async output => {
      const final = decipher.final(); count += final.length; plaintextHash.update(final);
      try { await output.writeFile(final); } finally { final.fill(0); }
      if (count !== entry.bytes || plaintextHash.digest('hex') !== entry.sha256 || ciphertextHash.digest('hex') !== seal.ciphertextSha256)
        throw new Error('backup_object_integrity_failed');
    });
  } catch { throw new Error('backup_object_validation_failed'); }
}

type File = Awaited<ReturnType<typeof open>>;
async function transformFile(source: string, destination: string, expectedBytes: number,
  transform: (chunk: Buffer, output: File) => Promise<void>, finish: (output: File) => Promise<void>): Promise<void> {
  const identity = await lstat(source);
  if (!identity.isFile() || identity.isSymbolicLink() || identity.size !== expectedBytes) throw new Error('backup_source_file_invalid');
  let input: File | undefined, output: File | undefined, created = false;
  const buffer = Buffer.alloc(128 * 1024);
  try {
    input = await open(source, 'r'); const opened = await input.stat();
    if (opened.dev !== identity.dev || opened.ino !== identity.ino || opened.size !== identity.size || opened.mtimeMs !== identity.mtimeMs)
      throw new Error('backup_source_identity_changed');
    output = await open(destination, 'wx', 0o600); created = true; let scanned = 0;
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null); if (bytesRead === 0) break;
      scanned += bytesRead; if (scanned > expectedBytes) throw new Error('backup_source_size_changed');
      await transform(buffer.subarray(0, bytesRead), output);
    }
    const after = await input.stat(), named = await lstat(source);
    if (scanned !== expectedBytes || after.mtimeMs !== opened.mtimeMs || after.size !== opened.size
      || named.dev !== opened.dev || named.ino !== opened.ino || named.isSymbolicLink()) throw new Error('backup_source_identity_changed');
    await finish(output); await output.sync(); await output.close(); output = undefined;
  } catch (error) {
    await output?.close(); output = undefined;
    if (created) await unlink(destination);
    throw error;
  } finally { buffer.fill(0); await input?.close(); await output?.close(); }
}

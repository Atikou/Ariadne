import { z } from 'zod';
import { RUNTIME_DATABASE_PATHS } from '../runtime/runtime-storage-layout';

export const BACKUP_FORMAT = 'ariadne.same-machine-backup' as const;
export const MAX_BACKUP_FILES = 20_000;
export const MAX_BACKUP_MANIFEST_BYTES = 16 * 1024 * 1024;
export type BackupScope = 'userData' | 'runtime' | 'sessionData';
export interface BackupFixedFile {
  readonly scope: BackupScope; readonly path: string;
  readonly kind: 'database' | 'private-file' | 'profile-key';
  readonly required: boolean;
}
export const BACKUP_FIXED_FILES: readonly BackupFixedFile[] = Object.freeze([
  ...Object.values(RUNTIME_DATABASE_PATHS).map(path => Object.freeze({ scope: 'runtime' as const, path, kind: 'database' as const, required: true })),
  ...['state.json', 'settings.toml', 'decision-notifications.json', 'chat-drafts.json', 'file-drafts.json',
    'agent-input-delivery-outbox.json', 'mcp-oauth-vault.json', 'terminal-sessions.json'].map(path =>
    Object.freeze({ scope: 'userData' as const, path, kind: 'private-file' as const, required: false })),
  Object.freeze({ scope: 'userData' as const, path: 'agent-persistence-keyring.json', kind: 'private-file' as const, required: true }),
  Object.freeze({ scope: 'userData' as const, path: 'notification-delivery.db', kind: 'database' as const, required: false }),
  Object.freeze({ scope: 'sessionData' as const, path: 'Local State', kind: 'profile-key' as const, required: true })
]);

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const entryFields = {
  scope: z.enum(['userData', 'runtime', 'sessionData']), path: z.string().min(1).max(256),
  kind: z.enum(['database', 'private-file', 'profile-key', 'attachment']),
  bytes: z.number().int().min(0).max(128 * 1024 * 1024 * 1024), sha256,
  sqlite: z.object({ userVersion: z.number().int().nonnegative(), schemaDigest: sha256 }).strict().nullable()
};
const entrySchema = z.object(entryFields).strict().superRefine((entry, context) => {
  const fixed = BACKUP_FIXED_FILES.find(file => file.scope === entry.scope && file.path === entry.path);
  const attachment = /^data\/conversation\/attachments\/v1\/objects\/([a-f0-9]{2})\/([a-f0-9]{64})$/u.exec(entry.path);
  if (!(fixed && fixed.kind === entry.kind) && !(entry.kind === 'attachment' && entry.scope === 'runtime'
    && attachment && attachment[1] === attachment[2]!.slice(0, 2) && attachment[2] === entry.sha256))
    context.addIssue({ code: 'custom', message: 'Backup entry is outside the current owned storage inventory.' });
  if ((entry.kind === 'database') !== (entry.sqlite !== null))
    context.addIssue({ code: 'custom', message: 'Database entries require physical SQLite metadata.' });
  if (entry.kind === 'attachment' && entry.bytes > 1536 * 1024)
    context.addIssue({ code: 'custom', message: 'Attachment exceeds the original published-object limit.' });
});
export type BackupFileEntry = z.infer<typeof entrySchema>;
export function validateBackupFileEntry(value: BackupFileEntry): BackupFileEntry { return entrySchema.parse(value); }

/** Internal, authenticated manifest. No absolute paths, credentials or bodies are
 * accepted as metadata, and no backup entry can authorize an arbitrary restore path. */
export const backupManifestSchema = z.object({
  format: z.literal(BACKUP_FORMAT), version: z.literal(1), backupId: z.uuid(),
  appVersion: z.string().min(1).max(64), runtimeProtocol: z.literal('3.0'), publicContract: z.literal('5.0'),
  createdAt: z.iso.datetime(), platform: z.literal('win32'), recoveryScope: z.literal('same-machine-current-user'),
  unpublishedAttachmentFilesExcluded: z.number().int().nonnegative().max(MAX_BACKUP_FILES),
  boundary: z.object({ runtimeInstanceId: z.uuid(), quiescedAt: z.iso.datetime(), shutdownAcknowledged: z.literal(true),
    mainStoresFlushed: z.literal(true), storageSchemas: z.record(z.string().regex(/^[A-Za-z0-9._-]{1,64}$/u),
      z.number().int().nonnegative()).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 64) }).strict(),
  files: z.array(entrySchema).min(1).max(MAX_BACKUP_FILES),
  absent: z.array(z.object({ scope: z.enum(['userData', 'runtime', 'sessionData']), path: z.string().max(256) }).strict())
    .max(BACKUP_FIXED_FILES.length),
  exclusions: z.tuple([z.literal('model-weights'), z.literal('workspace-original-files'), z.literal('derived-search-and-task-indexes')])
}).strict().superRefine((manifest, context) => {
  const identities = new Set<string>();
  for (const file of [...manifest.files, ...manifest.absent]) {
    const identity = `${file.scope}:${file.path}`;
    if (identities.has(identity)) context.addIssue({ code: 'custom', message: 'Duplicate or contradictory backup entry.' });
    identities.add(identity);
  }
  for (const file of BACKUP_FIXED_FILES) {
    if (!identities.has(`${file.scope}:${file.path}`) || (file.required && !manifest.files.some(entry => entry.scope === file.scope && entry.path === file.path)))
      context.addIssue({ code: 'custom', message: 'Owned storage inventory is incomplete.' });
  }
  if (manifest.absent.some(entry => !BACKUP_FIXED_FILES.some(file => !file.required && file.scope === entry.scope && file.path === entry.path)))
    context.addIssue({ code: 'custom', message: 'Only optional owned files may be absent.' });
});
export type BackupManifest = z.infer<typeof backupManifestSchema>;

export function parseBackupManifest(raw: string): BackupManifest {
  if (Buffer.byteLength(raw, 'utf8') > MAX_BACKUP_MANIFEST_BYTES) throw new Error('backup_manifest_capacity_exceeded');
  return backupManifestSchema.parse(JSON.parse(raw));
}

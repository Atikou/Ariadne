import { describe, expect, it } from 'vitest';
import { BACKUP_FIXED_FILES, backupManifestSchema, parseBackupManifest, type BackupManifest } from '../src/main/data-management/backup-manifest';

function manifest(): BackupManifest {
  return { format: 'ariadne.same-machine-backup', version: 1, backupId: '11111111-1111-4111-8111-111111111111',
    appVersion: '0.1.0', runtimeProtocol: '3.0', publicContract: '5.0', createdAt: '2026-10-06T00:00:00.000Z', platform: 'win32',
    recoveryScope: 'same-machine-current-user', unpublishedAttachmentFilesExcluded: 0, boundary: { runtimeInstanceId: '22222222-2222-4222-8222-222222222222',
      quiescedAt: '2026-10-06T00:00:00.000Z', shutdownAcknowledged: true, mainStoresFlushed: true, storageSchemas: { agentControl: 7 } },
    files: BACKUP_FIXED_FILES.map(file => ({ scope: file.scope, path: file.path, kind: file.kind, bytes: 1, sha256: 'a'.repeat(64),
      sqlite: file.kind === 'database' ? { userVersion: 1, schemaDigest: 'b'.repeat(64) } : null })), absent: [],
    exclusions: ['model-weights', 'workspace-original-files', 'derived-search-and-task-indexes'] };
}

describe('same-machine backup inventory and manifest', () => {
  it('covers original authorities, encrypted stores and both notification ledgers, without optional data disappearing silently', () => {
    const value = manifest();
    expect(parseBackupManifest(JSON.stringify(value)).files).toHaveLength(BACKUP_FIXED_FILES.length);
    const preference = value.files.findIndex(entry => entry.path === 'state.json');
    const [removed] = value.files.splice(preference, 1);
    expect(backupManifestSchema.safeParse(value).success).toBe(false);
    value.absent = [{ scope: removed!.scope, path: removed!.path }];
    expect(backupManifestSchema.safeParse(value).success).toBe(true);
    value.files.splice(value.files.findIndex(entry => entry.path === 'agent-persistence-keyring.json'), 1);
    value.absent.push({ scope: 'userData', path: 'agent-persistence-keyring.json' });
    expect(backupManifestSchema.safeParse(value).success).toBe(false);
  });

  it('rejects traversal, arbitrary workspace/model files, duplicate identities and retired or cross-machine formats', () => {
    for (const path of ['../settings.toml', 'C:/Users/user/settings.toml', 'data\\conversation\\conversation.db',
      'workspace/private.txt', 'models/model.gguf', 'data/task-query/snapshots.db']) {
      const value = manifest(); value.files[0]!.path = path;
      expect(backupManifestSchema.safeParse(value).success, path).toBe(false);
    }
    const duplicate = manifest(); duplicate.files.push(duplicate.files[0]!);
    expect(backupManifestSchema.safeParse(duplicate).success).toBe(false);
    expect(backupManifestSchema.safeParse({ ...manifest(), format: 'legacy-agent-export' }).success).toBe(false);
    expect(backupManifestSchema.safeParse({ ...manifest(), recoveryScope: 'cross-machine' }).success).toBe(false);
    expect(backupManifestSchema.safeParse({ ...manifest(), boundary: { ...manifest().boundary, shutdownAcknowledged: false } }).success).toBe(false);
  });

  it('accepts only canonical content-addressed attachments and rejects mislabeled database metadata', () => {
    const value = manifest();
    value.files.push({ scope: 'runtime', path: `data/conversation/attachments/v1/objects/aa/${'a'.repeat(64)}`,
      kind: 'attachment', bytes: 512, sha256: 'a'.repeat(64), sqlite: null });
    expect(backupManifestSchema.safeParse(value).success).toBe(true);
    value.files.at(-1)!.sha256 = 'b'.repeat(64);
    expect(backupManifestSchema.safeParse(value).success).toBe(false);
    const invalid = manifest(); invalid.files[0]!.sqlite = null;
    expect(backupManifestSchema.safeParse(invalid).success).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { RUNTIME_DATABASE_PATHS, storageMaintenanceRequestSchema, storageMaintenanceResponseSchema } from '../src/host.js';

function response() {
  return { protocol: 'ariadne_storage_maintenance.v1', requestId: '11111111-1111-4111-8111-111111111111',
    outcome: { ok: true, result: { files: Object.values(RUNTIME_DATABASE_PATHS).map(path => ({
      path, bytes: 4096, sha256: 'a'.repeat(64), sqlite: { userVersion: 1, schemaDigest: 'b'.repeat(64) }
    })), unpublishedAttachmentFilesExcluded: 0 } } };
}
describe('private storage maintenance contract', () => {
  it('binds cleanup keys and exact versions without granting arbitrary filesystem paths or repeated categories', () => {
    const requestId = '11111111-1111-4111-8111-111111111111', keyId = 'agent-key-22222222-2222-4222-8222-222222222222';
    const request = { protocol: 'ariadne_storage_maintenance.v1', requestId, operation: 'execute-attachment-cleanup',
      dataRoot: 'C:\\Ariadne\\isolated-runtime', expectedVersion: 'a'.repeat(64), selected: ['orphan-attachment'],
      keyRing: { schemaVersion: 1, runtimeInstanceId: requestId, generation: 1, activeKeyId: keyId,
        keys: [{ keyId, keyMaterialBase64: Buffer.alloc(32, 1).toString('base64') }] } };
    expect(storageMaintenanceRequestSchema.safeParse(request).success).toBe(true);
    for (const change of [{ selected: [] }, { selected: ['orphan-attachment', 'orphan-attachment'] },
      { selected: ['history'] }, { expectedVersion: '../candidate' }, { paths: ['data/conversation/conversation.db'] },
      { keyRing: { ...request.keyRing, runtimeInstanceId: '33333333-3333-4333-8333-333333333333' } }])
      expect(storageMaintenanceRequestSchema.safeParse({ ...request, ...change }).success).toBe(false);
    const { expectedVersion: _version, selected: _selected, ...inspect } = request;
    expect(storageMaintenanceRequestSchema.safeParse({ ...inspect, operation: 'inspect-attachment-cleanup' }).success).toBe(true);
    expect(storageMaintenanceRequestSchema.safeParse({ ...request, operation: 'inspect-attachment-cleanup' }).success).toBe(false);
  });
  it('returns only bounded cleanup counts and explicit settlement metadata, excluding private candidates and keys', () => {
    const envelope = { protocol: 'ariadne_storage_maintenance.v1', requestId: '11111111-1111-4111-8111-111111111111' };
    const preview = { maintenance: 'attachment-cleanup-preview', version: 'a'.repeat(64), referencedObjects: 1,
      orphanObjects: 2, orphanBytes: 12, unpublishedObjects: 1, unpublishedBytes: 7 };
    const parse = (result: unknown) => storageMaintenanceResponseSchema.safeParse({ ...envelope, outcome: { ok: true, result } }).success;
    expect(parse(preview)).toBe(true); expect(parse({ ...preview, entries: [] })).toBe(false);
    expect(parse({ ...preview, keyRing: {} })).toBe(false); expect(parse({ ...preview, orphanBytes: 4 * 1024 * 1024 })).toBe(false);
    expect(parse({ ...preview, referencedObjects: 20_000 })).toBe(false);
    const settlement = { maintenance: 'attachment-cleanup-result', operationId: envelope.requestId,
      status: 'interrupted', filesDeleted: 1, bytesDeleted: 5, filesRetained: 2, auditRecorded: true };
    expect(parse(settlement)).toBe(true); expect(parse({ ...settlement, status: 'completed' })).toBe(false);
    expect(parse({ ...settlement, auditRecorded: false })).toBe(false);
    expect(parse({ ...settlement, sourcePath: 'C:\\Ariadne' })).toBe(false);
  });
  it('binds the original private recovery keyring to one operation and excludes it from readonly layout requests', () => {
    const requestId = '11111111-1111-4111-8111-111111111111', keyId = 'agent-key-22222222-2222-4222-8222-222222222222';
    const request = { protocol: 'ariadne_storage_maintenance.v1', requestId, operation: 'validate-recovery',
      dataRoot: 'C:\\Ariadne\\isolated-runtime', keyRing: { schemaVersion: 1, runtimeInstanceId: requestId,
        generation: 1, activeKeyId: keyId, keys: [{ keyId, keyMaterialBase64: Buffer.alloc(32, 1).toString('base64') }] } };
    expect(storageMaintenanceRequestSchema.safeParse(request).success).toBe(true);
    expect(storageMaintenanceRequestSchema.safeParse({ ...request, operation: 'validate-layout' }).success).toBe(false);
    expect(storageMaintenanceRequestSchema.safeParse({ ...request, keyRing: { ...request.keyRing,
      runtimeInstanceId: '33333333-3333-4333-8333-333333333333' } }).success).toBe(false);
    expect(storageMaintenanceRequestSchema.safeParse({ ...request, snapshotRoot: 'C:\\Ariadne\\write' }).success).toBe(false);
  });
  it('requires canonical absolute roots and excludes relative aliases before spawning storage work', () => {
    const request = { protocol: 'ariadne_storage_maintenance.v1', requestId: '11111111-1111-4111-8111-111111111111',
      operation: 'snapshot', dataRoot: 'C:\\Ariadne\\runtime', snapshotRoot: 'C:\\Ariadne\\staging' };
    expect(storageMaintenanceRequestSchema.safeParse(request).success).toBe(true);
    for (const dataRoot of ['relative', 'C:\\Ariadne\\..\\runtime', 'C:/Ariadne/runtime', 'C:\\Ariadne\\runtime\\', '/data/../runtime'])
      expect(storageMaintenanceRequestSchema.safeParse({ ...request, dataRoot }).success).toBe(false);
    expect(storageMaintenanceRequestSchema.safeParse({ ...request, plaintextKey: 'not permitted' }).success).toBe(false);
  });
  it('requires all seven owners once, exact database metadata and canonical attachment digest identities', () => {
    expect(storageMaintenanceResponseSchema.safeParse(response()).success).toBe(true);
    const duplicate = response(); duplicate.outcome.result.files[1] = duplicate.outcome.result.files[0]!;
    expect(storageMaintenanceResponseSchema.safeParse(duplicate).success).toBe(false);
    const wrong = response(); wrong.outcome.result.files[0]!.path = 'data/task-query/snapshots.db';
    expect(storageMaintenanceResponseSchema.safeParse(wrong).success).toBe(false);
    const missing = response(); missing.outcome.result.files.splice(0, 1);
    expect(storageMaintenanceResponseSchema.safeParse(missing).success).toBe(false);
    const swapped = response(); swapped.outcome.result.files[0]!.path = 'data/conversation/attachments/v1/objects/aa/' + 'a'.repeat(64);
    expect(storageMaintenanceResponseSchema.safeParse(swapped).success).toBe(false);
  });
  it('keeps readonly layout validation separate from snapshot grants and returns only physical owner versions', () => {
    const request = { protocol: 'ariadne_storage_maintenance.v1', requestId: '11111111-1111-4111-8111-111111111111',
      operation: 'validate-layout', dataRoot: 'C:\\Ariadne\\isolated-runtime' };
    expect(storageMaintenanceRequestSchema.safeParse(request).success).toBe(true);
    expect(storageMaintenanceRequestSchema.safeParse({ ...request, snapshotRoot: 'C:\\Ariadne\\write-grant' }).success).toBe(false);
    expect(storageMaintenanceRequestSchema.safeParse({ ...request, plaintextKey: 'unapproved' }).success).toBe(false);
    const result = { validation: 'current-layout', storageSchemas: { agentControl: 8, conversation: 4, publicProjection: 4,
      runtimeCommand: 1, productivity: 3, modelCapability: 1, longMemory: 1 } };
    const envelope = { protocol: request.protocol, requestId: request.requestId, outcome: { ok: true, result } };
    expect(storageMaintenanceResponseSchema.safeParse(envelope).success).toBe(true);
    expect(storageMaintenanceResponseSchema.safeParse({ ...envelope, outcome: { ok: true, result: { ...result, protectedPayloadsAccepted: true } } }).success).toBe(false);
  });
});

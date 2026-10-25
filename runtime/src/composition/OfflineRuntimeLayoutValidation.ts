import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATABASE_PATHS } from '../adapters/persistence/DatabasePaths.js';
import { acquireSqliteOwnerLease, closeOwnedSqliteDatabase, type SqliteOwnerLease } from '../adapters/persistence/SqliteOwnerLease.js';
import { assertAgentControlSchema, AGENT_CONTROL_DB_SCHEMA_VERSION } from '../adapters/persistence/agentControlDbSchema.js';
import { assertConversationSchema, CONVERSATION_DB_SCHEMA_VERSION } from '../adapters/persistence/ConversationDbSchema.js';
import { assertPublicProjectionSchema, PUBLIC_PROJECTION_CURRENT_DB_SCHEMA_VERSION } from '../adapters/persistence/PublicProjectionDbSchema.js';
import { auditStoredProjectionState } from '../adapters/persistence/SqlitePublicProjectionStore.js';
import { assertRuntimeCommandDatabaseSchema, RUNTIME_COMMAND_DB_SCHEMA_VERSION } from '../adapters/persistence/runtimeCommandDbMigrations.js';
import { assertProductivityTaskIsolationSchemaV3 } from '../adapters/persistence/ProductivityTaskIsolationSchemaV3.js';
import { auditProductivityAuthorityRecords, assertProductivitySqliteIntegrity } from '../adapters/persistence/ProductivityAuthorityAudit.js';
import { PRODUCTIVITY_DB_SCHEMA_VERSION } from '../adapters/persistence/ProductivityDbSchema.js';
import { auditLongMemoryAuthority } from '../adapters/persistence/LongMemoryAuthorityAudit.js';
import { LONG_MEMORY_DB_SCHEMA_VERSION } from '../adapters/persistence/LongMemoryDbSchema.js';
import { assertCommunicationContractReady } from '../adapters/persistence/CommunicationContractMigration.js';
import { AesGcmAgentPersistencePayloadCodec, AES_GCM_AGENT_PERSISTENCE_CODEC_ID } from '../adapters/persistence/AesGcmAgentPersistencePayloadCodec.js';
import { verifyKeyringAnchorReadOnly } from '../adapters/persistence/AgentControlKeyring.js';
import { auditOfflineAgentRecoveryPayloads } from '../adapters/persistence/OfflineAgentRecoveryPayloadAudit.js';
import { agentPersistenceKeyRingSchema } from '@ariadne/protocol/host';
import { auditOfflineConversationRecovery } from '../adapters/persistence/OfflineConversationRecoveryAudit.js';

const versions = Object.freeze({ agentControl: AGENT_CONTROL_DB_SCHEMA_VERSION, conversation: CONVERSATION_DB_SCHEMA_VERSION,
  publicProjection: PUBLIC_PROJECTION_CURRENT_DB_SCHEMA_VERSION, runtimeCommand: RUNTIME_COMMAND_DB_SCHEMA_VERSION,
  productivity: PRODUCTIVITY_DB_SCHEMA_VERSION, longMemory: LONG_MEMORY_DB_SCHEMA_VERSION });
type Owner = keyof typeof DATABASE_PATHS;
export interface OfflineModelCapabilityValidation {
  readonly schemaVersion: number;
  validate(database: DatabaseSync): void;
}
export class OfflineRecoveryValidationError extends Error {
  constructor(readonly phase: 'layout' | 'key-anchor' | 'agent-payloads' | 'conversation') { super('offline_recovery_validation_failed'); }
}

/** Reuses the original owners' validators against isolated copies. It opens no
 * writable business connection, never migrates or starts a Runtime actor. This
 * proves current layout/authority audits only; protected Agent decryption and
 * referenced attachment availability have separate validation requirements. */
export function validateOfflineRuntimeLayout(dataRoot: string, modelOwner: OfflineModelCapabilityValidation): {
  validation: 'current-layout'; storageSchemas: Readonly<Record<Owner, number>>
} {
  const owners = openValidatedRuntimeOwners(dataRoot, modelOwner);
  try { return { validation: 'current-layout', storageSchemas: owners.storageSchemas }; }
  finally { owners.close(); }
}

/** All original owner leases remain held through protected payload validation.
 * Key buffers and the original codec are destroyed before any owner releases. */
export async function validateOfflineRuntimeRecovery(dataRoot: string, modelOwner: OfflineModelCapabilityValidation,
  input: unknown, visit?: (databases: ReadonlyMap<Owner, DatabaseSync>) => Promise<void>): Promise<{
    validation: 'current-recovery'; storageSchemas: Readonly<Record<Owner, number>>; protectedArtifacts: number; referencedAttachments: number }> {
  const keyRing = agentPersistenceKeyRingSchema.parse(input), keys: { keyId: string; key: Buffer }[] = [];
  let owners: ReturnType<typeof openValidatedRuntimeOwners>;
  try { owners = openValidatedRuntimeOwners(dataRoot, modelOwner); }
  catch { throw new OfflineRecoveryValidationError('layout'); }
  let codec: AesGcmAgentPersistencePayloadCodec | undefined;
  let phase: 'key-anchor' | 'agent-payloads' | 'conversation' = 'key-anchor';
  try {
    let protectedArtifacts: number, referencedAttachments: number;
    try {
    for (const value of keyRing.keys) {
      const key = Buffer.from(value.keyMaterialBase64, 'base64'); keys.push({ keyId: value.keyId, key });
      if (key.length !== 32 || key.toString('base64') !== value.keyMaterialBase64) throw new Error('restore_validation_key_noncanonical');
    }
    codec = new AesGcmAgentPersistencePayloadCodec(keyRing.activeKeyId, keys);
    const agent = owners.databases.get('agentControl')!;
    verifyKeyringAnchorReadOnly(agent, { generation: keyRing.generation, activeKeyId: keyRing.activeKeyId,
      availableKeyIds: keys.map(value => value.keyId), requiredCodecId: AES_GCM_AGENT_PERSISTENCE_CODEC_ID });
    phase = 'agent-payloads'; protectedArtifacts = await auditOfflineAgentRecoveryPayloads(agent, codec);
    phase = 'conversation'; referencedAttachments = await auditOfflineConversationRecovery(owners.databases.get('conversation')!, dataRoot);
    } catch { throw new OfflineRecoveryValidationError(phase); }
    // Storage-only maintenance may inspect/settle exact orphan objects only
    // after every original authority and protected image has been validated,
    // while all seven leases and the read-only connections remain held.
    if (visit) await visit(owners.databases);
    return { validation: 'current-recovery', storageSchemas: owners.storageSchemas, protectedArtifacts, referencedAttachments };
  } finally { codec?.destroy(); for (const value of keys) value.key.fill(0); owners.close(); }
}

function openValidatedRuntimeOwners(dataRoot: string, modelOwner: OfflineModelCapabilityValidation): {
  databases: Map<Owner, DatabaseSync>; storageSchemas: Readonly<Record<Owner, number>>; close(): void
} {
  const currentVersions = Object.freeze({ ...versions, modelCapability: modelOwner.schemaVersion });
  if (!path.isAbsolute(dataRoot)) throw new Error('restore_validation_root_invalid');
  const namedRoot = lstatSync(dataRoot);
  if (!namedRoot.isDirectory() || namedRoot.isSymbolicLink()) throw new Error('restore_validation_root_invalid');
  const root = realpathSync(dataRoot), leases = new Map<Owner, SqliteOwnerLease>(), databases = new Map<Owner, DatabaseSync>();
  const close = (): void => {
    const faults: unknown[] = [];
    for (const [owner, lease] of [...leases.entries()].reverse()) {
      try { const database = databases.get(owner); if (database) closeOwnedSqliteDatabase(database, lease); else lease.close(); }
      catch (error) { faults.push(error); }
    }
    if (faults.length) throw new AggregateError(faults, 'restore_validation_owner_close_failed');
  };
  try {
    for (const owner of Object.keys(currentVersions) as Owner[]) {
      const file = ownedFile(root, DATABASE_PATHS[owner]);
      leases.set(owner, acquireSqliteOwnerLease(file, 'restore-validation-' + owner.toLowerCase()));
    }
    for (const owner of Object.keys(currentVersions) as Owner[]) {
      const database = new DatabaseSync(ownedFile(root, DATABASE_PATHS[owner]), { readOnly: true }); databases.set(owner, database);
      database.exec('PRAGMA query_only=ON; PRAGMA foreign_keys=ON;');
      if (Number(database.prepare('PRAGMA user_version').get()?.user_version) !== currentVersions[owner])
        throw new Error('restore_validation_current_version_required');
      for (const row of database.prepare('PRAGMA integrity_check').iterate()) if (row.integrity_check !== 'ok')
        throw new Error('restore_validation_sqlite_integrity_failed');
      if (database.prepare('PRAGMA foreign_key_check').iterate().next().value) throw new Error('restore_validation_sqlite_integrity_failed');
    }
    assertCommunicationContractReady(root);
    assertAgentControlSchema(databases.get('agentControl')!);
    assertConversationSchema(databases.get('conversation')!);
    const projection = databases.get('publicProjection')!; assertPublicProjectionSchema(projection); auditStoredProjectionState(projection);
    assertRuntimeCommandDatabaseSchema(databases.get('runtimeCommand')!);
    const productivity = databases.get('productivity')!; assertProductivityTaskIsolationSchemaV3(productivity);
    assertProductivitySqliteIntegrity(productivity); auditProductivityAuthorityRecords(productivity);
    modelOwner.validate(databases.get('modelCapability')!);
    auditLongMemoryAuthority(databases.get('longMemory')!);
    return { databases, storageSchemas: currentVersions, close };
  } catch (error) { close(); throw error; }
}

function ownedFile(root: string, relativePath: string): string {
  let current = root;
  for (const segment of relativePath.split('/')) {
    current = path.join(current, segment); if (lstatSync(current).isSymbolicLink()) throw new Error('restore_validation_source_alias');
  }
  if (!lstatSync(current).isFile() || realpathSync(current) !== current) throw new Error('restore_validation_database_invalid');
  return current;
}

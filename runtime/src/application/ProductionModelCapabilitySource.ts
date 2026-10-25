import type { RuntimeAuthorityHealthSource } from '../ingress/RuntimeAuthorityHealthSource.js';
import { readOwnedAuthorityFault } from '../adapters/persistence/SqliteAuthorityHealth.js';
import { ModelCapabilityRegistry, qualificationDatabasePath } from '../model/capability/ModelCapabilityRegistry.js';
import { assertModelCapabilityDatabaseSchema, MODEL_CAPABILITY_DB_SCHEMA_VERSION } from '../model/capability/ModelCapabilityDbSchema.js';
import { auditModelCapabilityAuthority } from '../model/capability/ModelCapabilityRecords.js';
import type { OfflineModelCapabilityValidation } from '../composition/OfflineRuntimeLayoutValidation.js';
import type { DatabaseSync } from 'node:sqlite';

/** The same model owner supplies its cold validator. No registry, probing or
 * inference is instantiated merely to audit an isolated database. */
export const productionModelCapabilityStorageValidation: OfflineModelCapabilityValidation = Object.freeze({
  schemaVersion: MODEL_CAPABILITY_DB_SCHEMA_VERSION,
  validate(database: DatabaseSync) { assertModelCapabilityDatabaseSchema(database); auditModelCapabilityAuthority(database); }
});

export interface ProductionModelCapabilitySource {
  readonly registry?: ModelCapabilityRegistry;
  readonly health: RuntimeAuthorityHealthSource;
}

/** An admitted registry remains the only capability authority. Only an
 * owner-attributed opening failure with confirmed cleanup permits isolated
 * composition. Unknown errors and aggregate cleanup failures still abort it. */
export function composeProductionModelCapabilitySource(dataRoot: string): ProductionModelCapabilitySource {
  try {
    const registry = new ModelCapabilityRegistry(qualificationDatabasePath(dataRoot));
    return { registry, health: registry };
  } catch (error) {
    if (readOwnedAuthorityFault(error)?.source !== 'inference') throw error;
    return { health: Object.freeze({ assertHealthy: () => { throw error; } }) };
  }
}

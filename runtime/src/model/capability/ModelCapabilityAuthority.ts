import type { ModelCapabilityQualification } from './ModelCapabilityQualification.js';

/** Fingerprint-bound evidence access, independent of the cache file/schema version. */
export interface ModelCapabilityAuthority {
  registerFingerprint(providerId: string, modelId: string, fingerprint: string): void;
  current(providerId: string, modelId: string): ModelCapabilityQualification | null;
  currentFingerprint(providerId: string, modelId: string): string | null;
  read(providerId: string, modelId: string, fingerprint: string): ModelCapabilityQualification;
  write(report: ModelCapabilityQualification): void;
}

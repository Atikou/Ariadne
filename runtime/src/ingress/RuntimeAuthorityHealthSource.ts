/** Composition metadata only; persistence and execution remain with their owners. */
export interface RuntimeAuthorityHealthSource {
  assertHealthy(): void;
  /** Actual optional external-service evidence, never a synthetic readiness probe. */
  hasExternalFailure?(): boolean;
}

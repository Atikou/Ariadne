import type { TrustedAgentToolRegistrationV1 } from '../../adapters/tool/TrustedAgentToolCatalogCompiler.js';
import type { HumanSkillCatalog } from '../../control/ports/HumanSkillCatalog.js';

export type ProductionSkillLayer = 'built_in' | 'user' | 'workspace';

export interface ProductionSkillInvocationPolicy {
  readonly modelInvocable: boolean;
  readonly userInvocable: boolean;
}

export interface ProductionSkillResourceDescriptor {
  /** POSIX-style path relative to the owning Skill package. */
  readonly relativePath: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly revision: string;
}

export interface ProductionSkillResource extends ProductionSkillResourceDescriptor {
  readonly bytes: Uint8Array;
}

export interface ProductionSkillDescriptor {
  readonly name: string;
  readonly description: string;
  readonly revision: string;
  readonly layer: ProductionSkillLayer;
  readonly invocation: ProductionSkillInvocationPolicy;
}

export interface ProductionSkillCandidate extends ProductionSkillDescriptor {
  readonly locator: unknown;
}

export interface ProductionSkillDefinition extends ProductionSkillDescriptor {
  readonly body: string;
  readonly resources: readonly ProductionSkillResourceDescriptor[];
}

export interface ProductionSkillLookup {
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly signal: AbortSignal;
}

export interface ProductionSkillProviderObservation {
  readonly candidates: readonly ProductionSkillCandidate[];
  readonly complete: boolean;
}

/** One statically composed, scope-aware source of Skill candidates and bodies. */
export interface ProductionSkillProvider {
  readonly providerId: string;
  /** Higher precedence replaces the same name from a lower-precedence provider. */
  readonly precedence: number;
  list(
    lookup: ProductionSkillLookup
  ): Promise<readonly ProductionSkillCandidate[] | ProductionSkillProviderObservation>;
  get(
    candidate: ProductionSkillCandidate,
    lookup: ProductionSkillLookup
  ): Promise<ProductionSkillDefinition | undefined>;
  readResource?(
    candidate: ProductionSkillCandidate,
    relativePath: string,
    lookup: ProductionSkillLookup
  ): Promise<ProductionSkillResource | undefined>;
  close?(): void | Promise<void>;
}

export interface ProductionSkillCatalogSnapshot {
  readonly snapshotVersion: 2;
  /** Whether the underlying provider observation was authoritative. */
  readonly complete: boolean;
  /** `last_good` is usable but records that the latest observation was incomplete. */
  readonly source: 'fresh' | 'last_good';
  readonly workspaceId: string;
  readonly catalogDigest: string;
  readonly missing: readonly string[];
  readonly skills: readonly ProductionSkillDescriptor[];
}

export interface ProductionSkillCatalog extends HumanSkillCatalog {
  snapshot(
    workspaceId: string,
    signal: AbortSignal
  ): Promise<ProductionSkillCatalogSnapshot>;
  renderAdmissionCatalog(workspaceId: string, signal: AbortSignal): Promise<string>;
  loadForUser(
    workspaceId: string,
    name: string,
    revision: string,
    signal: AbortSignal
  ): Promise<ProductionSkillDefinition>;
  readResourceForUser(
    workspaceId: string,
    name: string,
    revision: string,
    relativePath: string,
    signal: AbortSignal
  ): Promise<ProductionSkillResource>;
  createToolRegistrations(): readonly TrustedAgentToolRegistrationV1[];
  close(): Promise<void>;
}

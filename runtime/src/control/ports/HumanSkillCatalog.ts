export interface HumanSkillDescriptor {
  readonly name: string;
  readonly description: string;
  readonly revision: string;
  readonly layer: 'built_in' | 'user' | 'workspace';
  readonly invocation: {
    readonly modelInvocable: boolean;
    readonly userInvocable: boolean;
  };
}

export interface HumanSkillDefinition extends HumanSkillDescriptor {
  readonly body: string;
  readonly resources: readonly HumanSkillResourceDescriptor[];
}

export interface HumanSkillResourceDescriptor {
  readonly relativePath: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly revision: string;
}

export interface HumanSkillResource extends HumanSkillResourceDescriptor {
  readonly bytes: Uint8Array;
}

export interface HumanSkillCatalogSnapshot {
  readonly complete: boolean;
  readonly source: 'fresh' | 'last_good';
  readonly workspaceId: string;
  readonly catalogDigest: string;
  readonly skills: readonly HumanSkillDescriptor[];
}

/** Read-only, human-invocation view of the immutable production Skill catalog. */
export interface HumanSkillCatalog {
  snapshot(workspaceId: string, signal: AbortSignal): Promise<HumanSkillCatalogSnapshot>;
  loadForUser(
    workspaceId: string,
    name: string,
    revision: string,
    signal: AbortSignal
  ): Promise<HumanSkillDefinition>;
  readResourceForUser(
    workspaceId: string,
    name: string,
    revision: string,
    relativePath: string,
    signal: AbortSignal
  ): Promise<HumanSkillResource>;
}

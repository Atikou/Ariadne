import {
  listProfilesForRole,
  resolveRoleRequirements,
  type ListProfilesForRoleOptions,
} from "./model-capabilities.js";
import type { ModelAvailabilityRegistry } from "./model-availability.js";
import type { ModelProfile, RuleRouteResult } from "./types.js";

const COST_ORDER: Record<ModelProfile["relativeCost"], number> = {
  free: 0,
  low: 1,
  medium: 2,
  high: 3,
};

function sortPrimary(a: ModelProfile, b: ModelProfile, requiredLevel: number): number {
  const levelDiff = Math.abs(a.defaultLevel - requiredLevel) - Math.abs(b.defaultLevel - requiredLevel);
  if (levelDiff !== 0) return levelDiff;
  const costDiff = COST_ORDER[a.relativeCost] - COST_ORDER[b.relativeCost];
  if (costDiff !== 0) return costDiff;
  return (a.avgLatencyMs ?? 9999) - (b.avgLatencyMs ?? 9999);
}

function sortDraft(a: ModelProfile, b: ModelProfile): number {
  const localFirst = (a.provider === "local" ? 0 : 1) - (b.provider === "local" ? 0 : 1);
  if (localFirst !== 0) return localFirst;
  const costDiff = COST_ORDER[a.relativeCost] - COST_ORDER[b.relativeCost];
  if (costDiff !== 0) return costDiff;
  return (a.avgLatencyMs ?? 9999) - (b.avgLatencyMs ?? 9999);
}

function sortReview(a: ModelProfile, b: ModelProfile, requiredLevel: number): number {
  const levelOk = (p: ModelProfile) => (p.defaultLevel >= requiredLevel ? 0 : 1);
  const l = levelOk(a) - levelOk(b);
  if (l !== 0) return l;
  const jsonFirst = (p: ModelProfile) => (p.supportsJsonMode ? 0 : 1);
  const j = jsonFirst(a) - jsonFirst(b);
  if (j !== 0) return j;
  return sortPrimary(a, b, requiredLevel);
}

export interface ModelRegistryOptions {
  availability?: ModelAvailabilityRegistry;
}

export class ModelRegistry {
  constructor(
    private profiles: ModelProfile[],
    private readonly options: ModelRegistryOptions = {},
  ) {}

  /** 替换全部 profile（ModelProfileStore.reload 使用，保持 registry 引用不变）。 */
  replaceAll(profiles: ModelProfile[]): void {
    this.profiles = [...profiles];
  }

  listEnabled(localOnly?: boolean): ModelProfile[] {
    return this.profiles.filter(
      (p) => p.enabled && (!localOnly || p.provider === "local") && (this.options.availability?.isAllowed(p.id) ?? true),
    );
  }

  listAll(): ModelProfile[] {
    return [...this.profiles];
  }

  get(id: string): ModelProfile | undefined {
    return this.profiles.find((p) => p.id === id);
  }

  findPrimaryCandidates(
    rule: RuleRouteResult,
    localOnly?: boolean,
    routerInput?: ListProfilesForRoleOptions["routerInput"],
  ): ModelProfile[] {
    const requirement = resolveRoleRequirements(rule, "primary");
    const candidates = listProfilesForRole(this.listEnabled(localOnly), rule, "primary", {
      localOnly,
      routerInput,
    });
    return candidates.sort((a, b) => sortPrimary(a, b, requirement.minLevel));
  }

  findDraftCandidates(
    rule: RuleRouteResult,
    localOnly?: boolean,
    contextTokenEstimate?: number,
    routerInput?: ListProfilesForRoleOptions["routerInput"],
  ): ModelProfile[] {
    const tokenNeed = contextTokenEstimate ?? 8000;
    const candidates = listProfilesForRole(this.listEnabled(localOnly), rule, "draft", {
      localOnly,
      contextTokenEstimate: tokenNeed,
      allowDraftGeneralTypes: true,
      routerInput,
    });
    return candidates.sort(sortDraft);
  }

  findReviewCandidates(
    rule: RuleRouteResult,
    localOnly?: boolean,
    routerInput?: ListProfilesForRoleOptions["routerInput"],
  ): ModelProfile[] {
    const requirement = resolveRoleRequirements(rule, "review");
    const candidates = listProfilesForRole(this.listEnabled(localOnly), rule, "review", {
      localOnly,
      routerInput,
    });
    return candidates.sort((a, b) => sortReview(a, b, requirement.minLevel));
  }

  findFinalCandidates(rule: RuleRouteResult, localOnly?: boolean): ModelProfile[] {
    return this.findReviewCandidates(rule, localOnly).filter((p) => p.canFinal);
  }
}

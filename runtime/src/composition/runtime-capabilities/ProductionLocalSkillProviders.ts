import { existsSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

import {
  discoverLocalSkillCandidate,
  loadLocalSkillDefinition,
  loadLocalSkillResource
} from './ProductionLocalSkillPackage.js';
import type {
  ProductionSkillCandidate,
  ProductionSkillLayer,
  ProductionSkillLookup,
  ProductionSkillProvider
} from './ProductionSkillContracts.js';

export function createProductionLocalSkillProviders(input: {
  readonly installRoot: string;
  readonly userDirectory?: string;
}): readonly ProductionSkillProvider[] {
  return Object.freeze([
    localProvider('skills.built-in', 100, 'built_in', () => path.join(input.installRoot, 'skills')),
    localProvider('skills.user', 200, 'user', () => input.userDirectory),
    localProvider(
      'skills.workspace',
      300,
      'workspace',
      (lookup) => path.join(lookup.workspaceRoot, '.ariadne', 'skills')
    )
  ]);
}

function localProvider(
  providerId: string,
  precedence: number,
  layer: ProductionSkillLayer,
  rootFor: (lookup: ProductionSkillLookup) => string | undefined
): ProductionSkillProvider {
  return Object.freeze({
    providerId,
    precedence,
    list: async (lookup: ProductionSkillLookup) => {
      lookup.signal.throwIfAborted();
      const root = rootFor(lookup);
      if (root === undefined || !existsSync(root)) return [];
      const canonicalProviderRoot = realpathSync(root);
      const names = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^[a-z][a-z0-9_-]*$/u.test(entry.name))
        .map((entry) => entry.name)
        .sort(compareCodeUnits);
      return Object.freeze(names.flatMap((name) => {
        lookup.signal.throwIfAborted();
        const candidatePath = path.join(root, name, 'SKILL.md');
        if (!existsSync(candidatePath)) return [];
        return [discoverLocalSkillCandidate({
          canonicalProviderRoot,
          candidatePath,
          name,
          layer,
          signal: lookup.signal
        })];
      }));
    },
    get: async (candidate: ProductionSkillCandidate, lookup: ProductionSkillLookup) => (
      loadLocalSkillDefinition(candidate, lookup.signal)
    ),
    readResource: async (
      candidate: ProductionSkillCandidate,
      relativePath: string,
      lookup: ProductionSkillLookup
    ) => (
      loadLocalSkillResource(candidate, relativePath, lookup.signal)
    )
  });
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

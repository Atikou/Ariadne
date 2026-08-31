import { describe, expect, it } from 'vitest';

import {
  moduleId,
  type FeatureModuleDefinition,
  type ModuleServices
} from '../src/renderer/src/core/modules/module-contract.js';
import {
  createDeclaredModuleServices,
  ModuleRegistry
} from '../src/renderer/src/core/modules/module-registry.js';

const gatedModule: FeatureModuleDefinition = {
  id: moduleId('test.voice'),
  name: 'Voice',
  description: 'Capability-gated test component.',
  icon: 'message',
  component: () => null,
  consumes: [],
  defaultOpen: false,
  defaultPlacement: {},
  layoutConstraints: { minimumWidth: 100 },
  requiredCapabilities: ['wake.voice']
};

describe('UI ModuleRegistry', () => {
  it('fails closed when a required system capability is missing or unavailable', () => {
    expect(new ModuleRegistry([gatedModule]).list()).toEqual([]);
    expect(new ModuleRegistry([gatedModule], [{
      capability: 'wake.voice',
      availability: 'unavailable'
    }]).list()).toEqual([]);
  });

  it('publishes a component only when its required capability is present', () => {
    const registry = new ModuleRegistry([gatedModule], [{
      capability: 'wake.voice',
      availability: 'degraded'
    }]);
    expect(registry.list().map((definition) => definition.id)).toEqual(['test.voice']);
  });

  it('rejects access to services not declared by the component', () => {
    const runtime = {} as ModuleServices['runtime'];
    const definition = {
      ...gatedModule,
      id: moduleId('test.runtime'),
      consumes: ['runtime'] as const,
      requiredCapabilities: []
    };
    const scope = createDeclaredModuleServices(
      definition,
      { runtime } as ModuleServices
    );
    expect(scope.runtime).toBe(runtime);
    expect(() => scope.speech).toThrow(
      'Module test.runtime cannot access undeclared service speech.'
    );
  });
});

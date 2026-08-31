import { describe, expect, it } from 'vitest';

import {
  moduleId,
  type FeatureModuleDefinition
} from '../src/renderer/src/core/modules/module-contract.js';
import { ModuleRegistry } from '../src/renderer/src/core/modules/module-registry.js';

const gatedModule: FeatureModuleDefinition = {
  id: moduleId('test.voice'),
  name: 'Voice',
  description: 'Capability-gated test component.',
  icon: 'message',
  component: () => null,
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
});

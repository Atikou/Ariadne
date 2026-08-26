import type { RuntimeCapabilityManifest } from '../ingress/RuntimeCapabilityManifest.js';
import {
  createProductionRuntimeCapabilityStartContext,
  type ProductionRuntimeCapabilityManifestInput
} from './runtime-capabilities/ProductionRuntimeCapabilityContext.js';
import { productionRuntimeCapabilityProviders } from './runtime-capabilities/ProductionRuntimeCapabilityProviders.js';
import { compileRuntimeCapabilityManifest } from './runtime-capabilities/RuntimeCapabilityManifestCompiler.js';

export type { ProductionRuntimeCapabilityManifestInput };
export { createProductionRuntimeCapabilityStartContext };
export { productionRuntimeCapabilityProviders };
export { compileRuntimeCapabilityManifest };
export type {
  RuntimeCapabilityHandle,
  RuntimeCapabilityProvider,
  RuntimeCapabilityStartContext
} from './runtime-capabilities/RuntimeCapabilityProvider.js';

/** Fixed, audited production composition; no runtime module discovery. */
export function compileProductionRuntimeCapabilityManifest(
  input: ProductionRuntimeCapabilityManifestInput
): Promise<RuntimeCapabilityManifest> {
  return compileRuntimeCapabilityManifest(
    createProductionRuntimeCapabilityStartContext(input),
    productionRuntimeCapabilityProviders()
  );
}

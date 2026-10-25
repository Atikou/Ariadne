import type { RuntimeCapability } from '@ariadne/protocol/public';

/** Historical tokens remain decodable, but cannot acquire production authority again. */
export const RETIRED_RUNTIME_CAPABILITIES: readonly RuntimeCapability[] = Object.freeze(['agent.proposals', 'resources']);
export function isRetiredRuntimeCapability(capability: RuntimeCapability): boolean {
  return RETIRED_RUNTIME_CAPABILITIES.includes(capability);
}

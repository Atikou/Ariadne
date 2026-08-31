import { createProtectedResultAgentToolRegistrations } from '../../../first-party-tools/ProtectedResultAgentTools.js';
import { defineRuntimeCapabilityProvider } from '../../RuntimeCapabilityProvider.js';

/** Vertical sample: protected read-only Tool contribution discovered by the generated Catalog. */
export default Object.freeze([
  defineRuntimeCapabilityProvider({
    id: 'tool-result.protected-detail',
    dependsOn: ['workspace.tools'],
    publicCapabilities: [],
    start: (context) => ({
      publicCapabilities: [],
      tools: createProtectedResultAgentToolRegistrations(context.workspaceBindings)
    })
  })
]);

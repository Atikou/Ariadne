import { describe, expect, it } from 'vitest';

import {
  agentEntityCommandComponent,
  compileAgentEntityCommandManifest
} from '../src/composition/agent-entity/AgentEntityCompiler.js';
import {
  defineAgentPublicCommandOwner
} from '../src/composition/agent-entity/command-owners/AgentPublicCommandOwnerTable.js';

describe('AgentEntityCompiler', () => {
  it('publishes deterministic component and owner diagnostics', () => {
    const manifest = compileAgentEntityCommandManifest([
      agentEntityCommandComponent('agent.zeta', [owner('projection.commits.read')]),
      agentEntityCommandComponent('agent.alpha', [owner('projection.snapshot.get')])
    ]);

    expect(manifest.components).toEqual([
      { componentId: 'agent.alpha', ownerIds: ['owner.projection.snapshot.get'] },
      { componentId: 'agent.zeta', ownerIds: ['owner.projection.commits.read'] }
    ]);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.components)).toBe(true);
  });

  it('fails before publication on duplicate, empty, or invalid components', () => {
    expect(() => compileAgentEntityCommandManifest([
      agentEntityCommandComponent('agent.same', [owner('projection.snapshot.get')]),
      agentEntityCommandComponent('agent.same', [owner('projection.commits.read')])
    ])).toThrow('agent_entity_component_duplicate:agent.same');
    expect(() => compileAgentEntityCommandManifest([
      agentEntityCommandComponent('agent.empty', [])
    ])).toThrow('agent_entity_command_component_empty:agent.empty');
    expect(() => compileAgentEntityCommandManifest([
      agentEntityCommandComponent('not-agent', [owner('projection.snapshot.get')])
    ])).toThrow('agent_entity_component_id_invalid:not-agent');
  });
});

function owner(kind: 'projection.snapshot.get' | 'projection.commits.read') {
  return defineAgentPublicCommandOwner(`owner.${kind}`, [kind], async () => {
    throw new Error('not_executed');
  }, async () => ({ kind: 'not_committed' }));
}

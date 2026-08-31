import { describe, expect, it } from 'vitest';

import {
  compileAgentEntityManifest,
  type AgentEntityManifest
} from '../src/composition/agent-entity/AgentEntityManifest.js';

describe('AgentEntityManifest', () => {
  it('freezes the complete entity assembly input and clones workspace identities', () => {
    const workspaceIds = ['workspace-a'];
    const manifest = compileAgentEntityManifest({
      persistence: {} as AgentEntityManifest['persistence'],
      options: { publishIntervalMs: 25 },
      authorizedWorkspaceIds: workspaceIds
    });
    workspaceIds.push('workspace-b');

    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.options)).toBe(true);
    expect(Object.isFrozen(manifest.authorizedWorkspaceIds)).toBe(true);
    expect(manifest.authorizedWorkspaceIds).toEqual(['workspace-a']);
  });

  it('rejects empty and duplicate authorized workspace identities', () => {
    const persistence = {} as AgentEntityManifest['persistence'];
    expect(() => compileAgentEntityManifest({
      persistence,
      options: {},
      authorizedWorkspaceIds: ['workspace-a', 'workspace-a']
    })).toThrow('agent_entity_manifest_workspace_ids_invalid');
    expect(() => compileAgentEntityManifest({
      persistence,
      options: {},
      authorizedWorkspaceIds: ['']
    })).toThrow('agent_entity_manifest_workspace_ids_invalid');
  });
});

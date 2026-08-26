import { describe, expect, it } from 'vitest';

import {
  FIRST_PARTY_AGENT_TOOL_CATALOG_DIGEST,
  FIRST_PARTY_AGENT_TOOL_CATALOG_ID
} from '@ariadne/protocol/host';
import {
  buildAgentAdmissionAuthoritySource
} from '../src/main/runtime/agent-admission-authority-source';

const base = {
  settingsRevision: 4,
  permissionMode: 'risk-based' as const,
  allowedPermissions: ['read', 'write', 'shell', 'network'] as const,
  workspaces: [{ workspaceId: 'workspace-1', access: 'write' as const }],
  modelProviders: [{ providerId: 'provider-1', enabled: true, model: 'model-1' }],
  now: new Date('2026-08-07T00:00:00.000Z')
};

describe('Main Agent admission authority source builder', () => {
  it('compiles current settings into the exact first-party authority', () => {
    const source = buildAgentAdmissionAuthoritySource(base);
    expect(source).toMatchObject({
      sourceVersion: 1,
      status: 'enabled',
      manifests: [{
        workspace: { workspaceId: 'workspace-1', access: 'write' },
        model: { providerId: 'provider-1', modelId: 'model-1', settingsRevision: 4 },
        capabilityGrant: {
          capabilities: [
            { capabilityId: 'browser.use' },
            { capabilityId: 'workspace.read' },
            { capabilityId: 'workspace.shell' },
            { capabilityId: 'workspace.write' }
          ]
        },
        toolCatalog: {
          catalogId: FIRST_PARTY_AGENT_TOOL_CATALOG_ID,
          digest: FIRST_PARTY_AGENT_TOOL_CATALOG_DIGEST
        }
      }]
    });
  });

  it('authorizes every configured Provider and local model root without a wildcard', () => {
    const source = buildAgentAdmissionAuthoritySource({
      ...base,
      modelProviders: [
        { providerId: 'provider-1', enabled: true, model: 'model-1' },
        { providerId: 'provider-2', enabled: true, model: 'model-2' }
      ],
      localModelRoots: ['E:\\Models']
    });
    expect(source).toMatchObject({
      status: 'enabled',
      manifests: [{
        modelCandidates: [
          { providerId: 'provider-1', modelId: 'model-1', settingsRevision: 4 },
          { providerId: 'provider-2', modelId: 'model-2', settingsRevision: 4 },
          {
            providerId: 'ariadne.local',
            modelId: '__runtime_selected_local__',
            settingsRevision: 4
          }
        ]
      }]
    });
  });

  it('grants MCP only when an enabled remote server and network permission exist', () => {
    const enabled = buildAgentAdmissionAuthoritySource({ ...base, mcpEnabled: true });
    expect(enabled.status).toBe('enabled');
    if (enabled.status !== 'enabled') return;
    expect(enabled.manifests[0]!.capabilityGrant.capabilities).toContainEqual({
      capabilityId: 'mcp.use',
      scopeIds: ['workspace-1']
    });

    const offline = buildAgentAdmissionAuthoritySource({
      ...base,
      mcpEnabled: true,
      allowedPermissions: ['read']
    });
    expect(offline.status).toBe('enabled');
    if (offline.status !== 'enabled') return;
    expect(offline.manifests[0]!.capabilityGrant.capabilities).not.toContainEqual(
      expect.objectContaining({ capabilityId: 'mcp.use' })
    );
  });

  it('only admits tools whose complete capability requirements are granted', () => {
    const readOnly = buildAgentAdmissionAuthoritySource({
      ...base,
      allowedPermissions: ['read']
    });
    expect(readOnly.status).toBe('enabled');
    if (readOnly.status !== 'enabled') return;
    expect(readOnly.manifests[0]!.toolCatalog.allowedToolNames).toEqual([
      'workspace.list_files',
      'workspace.read_file'
    ]);

    const networkOnly = buildAgentAdmissionAuthoritySource({
      ...base,
      allowedPermissions: ['read', 'network'],
      mcpEnabled: false
    });
    expect(networkOnly.status).toBe('enabled');
    if (networkOnly.status !== 'enabled') return;
    expect(networkOnly.manifests[0]!.toolCatalog.allowedToolNames).toEqual([
      'browser.accessibility_snapshot',
      'browser.click',
      'browser.navigate',
      'browser.scroll',
      'browser.type',
      'browser.wait',
      'workspace.list_files',
      'workspace.read_file'
    ]);
  });

  it('excludes archived Workspaces and narrows read-only grants', () => {
    const source = buildAgentAdmissionAuthoritySource({
      ...base,
      workspaces: [
        { workspaceId: 'workspace-1', access: 'read' },
        { workspaceId: 'archived', access: 'write', archivedAt: '2026-08-01T00:00:00.000Z' }
      ]
    });
    expect(source.status).toBe('enabled');
    if (source.status !== 'enabled') return;
    expect(source.manifests).toHaveLength(1);
    expect(source.manifests[0]!.capabilityGrant.capabilities).toEqual([
      { capabilityId: 'browser.use', scopeIds: ['workspace-1'] },
      { capabilityId: 'workspace.read', scopeIds: ['workspace-1'] }
    ]);
  });

  it('keeps Agent admission enabled for an authorized local-only model root', () => {
    const source = buildAgentAdmissionAuthoritySource({
      ...base,
      modelProviders: [{ providerId: 'provider-1', enabled: false, model: 'model-1' }],
      localModelRoots: ['E:\\Models']
    });
    expect(source).toMatchObject({
      status: 'enabled',
      manifests: [{
        model: {
          providerId: 'ariadne.local',
          modelId: '__runtime_selected_local__',
          settingsRevision: 4
        }
      }]
    });
  });

  it('fails closed for missing models or invalid settings identity', () => {
    expect(buildAgentAdmissionAuthoritySource({
      ...base,
      modelProviders: [{ providerId: 'provider-1', enabled: false, model: 'model-1' }]
    })).toMatchObject({ status: 'disabled', reason: 'not_configured' });
    expect(buildAgentAdmissionAuthoritySource({
      ...base,
      settingsRevision: 0
    })).toMatchObject({ status: 'disabled', reason: 'invalid_first_party_configuration' });
    expect(buildAgentAdmissionAuthoritySource({
      ...base,
      workspaces: [
        { workspaceId: 'workspace-1', access: 'write' },
        { workspaceId: 'workspace-1', access: 'write' }
      ]
    })).toMatchObject({ status: 'disabled' });
  });
});

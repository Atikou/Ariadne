import { describe, expect, it } from 'vitest';

import {
  agentAdmissionAuthoritySourceManifestSchema,
  agentAdmissionAuthoritySourceSchema,
  parseHostToRuntimeMessage,
  ARIADNE_RUNTIME_PROTOCOL,
  ARIADNE_RUNTIME_PROTOCOL_VERSION
} from '../src/host.js';
import { createDefaultRuntimePolicySnapshot } from '../src/settings.js';

describe('Host Agent admission authority source', () => {
  it('accepts one complete, strict, JSON-serializable first-party manifest', () => {
    const source = agentAdmissionAuthoritySourceSchema.parse({
      sourceVersion: 1,
      status: 'enabled',
      manifests: [manifest()]
    });

    expect(source).toMatchObject({
      status: 'enabled',
      manifests: [{
        workspace: { revision: 3, scopeIds: ['scope.project'] },
        model: { settingsRevision: 9 },
        rootBudget: { deadlinePolicy: { kind: 'absolute' } }
      }]
    });
    expect(() => JSON.parse(JSON.stringify(source))).not.toThrow();
  });

  it('rejects incomplete, unsorted, duplicated, or scope-widening authority data', () => {
    const complete = manifest();
    expect(agentAdmissionAuthoritySourceManifestSchema.safeParse({
      ...complete,
      model: { providerId: 'provider-1', modelId: 'model-1' }
    }).success).toBe(false);
    expect(agentAdmissionAuthoritySourceManifestSchema.safeParse({
      ...complete,
      workspace: { ...complete.workspace, scopeIds: ['scope.z', 'scope.a'] }
    }).success).toBe(false);
    expect(agentAdmissionAuthoritySourceManifestSchema.safeParse({
      ...complete,
      capabilityGrant: {
        ...complete.capabilityGrant,
        capabilities: [{ capabilityId: 'file-read', scopeIds: ['scope.other'] }]
      }
    }).success).toBe(false);
    expect(agentAdmissionAuthoritySourceSchema.safeParse({
      sourceVersion: 1,
      status: 'enabled',
      manifests: [complete, { ...complete, manifestId: 'manifest-2' }]
    }).success).toBe(false);
  });

  it('requires Main to send an explicit enabled or disabled source in bootstrap', () => {
    const bootstrap = {
      protocol: ARIADNE_RUNTIME_PROTOCOL,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: '744b7985-512d-49ef-bc1e-7cb87674ea3f',
      type: 'bootstrap',
      appVersion: '0.1.0',
      runtimeVersion: '0.1.0',
      runtimeBuildFingerprint: 'a'.repeat(64),
      installRoot: 'E:\\Ariadne\\runtime',
      dataRoot: 'C:\\Ariadne\\data',
      modelRoots: [],
      runtimePolicy: createDefaultRuntimePolicySnapshot(),
      profile: 'default',
      workspaces: [{
        workspaceId: 'workspace-1',
        label: 'Workspace',
        rootPath: 'E:\\Workspace',
        access: 'write'
      }],
      production: true
    } as const;

    expect(() => parseHostToRuntimeMessage(bootstrap)).toThrow();
    expect(parseHostToRuntimeMessage({
      ...bootstrap,
      agentAdmissionAuthoritySource: {
        sourceVersion: 1,
        status: 'disabled',
        reason: 'not_configured'
      }
    })).toMatchObject({
      agentAdmissionAuthoritySource: {
        status: 'disabled',
        reason: 'not_configured'
      }
    });
  });
});

function manifest() {
  return {
    manifestVersion: 1,
    manifestId: 'manifest-1',
    revision: 2,
    workspace: {
      workspaceId: 'workspace-1',
      revision: 3,
      grantDigest: `sha256:${'a'.repeat(64)}`,
      access: 'write',
      scopeIds: ['scope.project']
    },
    model: {
      providerId: 'provider-1',
      modelId: 'model-1',
      settingsRevision: 9
    },
    policy: {
      policyId: 'policy-1',
      revision: 4,
      permissionMode: 'ask'
    },
    capabilityGrant: {
      grantId: 'capability-grant-1',
      revision: 5,
      capabilities: [{ capabilityId: 'file-read', scopeIds: ['scope.project'] }]
    },
    toolCatalog: {
      catalogId: 'tool-catalog-1',
      revision: 6,
      digest: `sha256:${'b'.repeat(64)}`,
      allowedToolNames: ['read_file']
    },
    rootBudget: {
      authorityId: 'root-budget-authority-1',
      revision: 7,
      vector: {
        modelTurns: 8,
        toolCalls: 20,
        readCalls: 15,
        writeCalls: 4,
        shellCalls: 2,
        costMicrousd: 100_000
      },
      deadlinePolicy: {
        kind: 'absolute',
        deadlineAt: '2099-08-01T00:00:00.000Z'
      }
    }
  } as const;
}

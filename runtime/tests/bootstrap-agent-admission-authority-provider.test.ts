import { describe, expect, it } from 'vitest';

import type {
  AgentAdmissionAuthoritySource,
  AgentAdmissionAuthoritySourceManifest
} from '@ariadne/protocol/host';

import {
  assertAgentAdmissionAuthorityBundle,
  type AgentAdmissionAuthorityQueryV2
} from '../src/control/ports/AgentAdmissionAuthority.js';
import {
  compileBootstrapAgentAdmissionAuthoritySource
} from '../src/composition/BootstrapAgentAdmissionAuthorityBundleProvider.js';

const future = '2099-08-01T00:00:00.000Z';
const query: AgentAdmissionAuthorityQueryV2 = {
  queryVersion: 2,
  subjectVersion: 2,
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  objectiveMessageId: 'message-1',
  objectiveMessageVersion: 2,
  objectiveDigest: `sha256:${'a'.repeat(64)}`,
  runId: 'run-1',
  execution: { mode: 'agent' }
};

describe('bootstrap Agent admission authority provider', () => {
  it('binds a complete first-party source to the exact immutable query', async () => {
    const provider = compileBootstrapAgentAdmissionAuthoritySource(enabledSource(), {
      now: () => Date.parse('2099-07-31T00:00:00.000Z')
    });
    const first = await provider.readAuthorityBundle(query, new AbortController().signal);
    const replay = await provider.readAuthorityBundle(query, new AbortController().signal);

    expect(first).not.toBeNull();
    if (first === null || replay === null) throw new Error('Expected authority bundle.');
    expect(() => assertAgentAdmissionAuthorityBundle(first)).not.toThrow();
    expect(first).toMatchObject({
      authorityBundleVersion: 2,
      revision: 7,
      subject: {
        subjectVersion: 2,
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        objectiveMessageId: 'message-1',
        objectiveMessageVersion: 2,
        objectiveDigest: `sha256:${'a'.repeat(64)}`,
        runId: 'run-1',
        executionProfile: { mode: 'agent' }
      },
      workspace: {
        workspaceId: 'workspace-1',
        revision: 11,
        scopeIds: ['scope.project']
      },
      model: {
        providerId: 'provider-1',
        modelId: 'model-1',
        settingsRevision: 13
      },
      rootBudget: {
        authorityId: 'root-budget-authority-1',
        revision: 17,
        runId: 'run-1',
        deadlineAt: future
      }
    });
    expect(replay.bundleId).toBe(first.bundleId);
    expect(replay.rootBudget.grantId).toBe(first.rootBudget.grantId);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('derives distinct bundle and root budget grant identities for another Run', async () => {
    const provider = compileBootstrapAgentAdmissionAuthoritySource(enabledSource(), {
      now: () => Date.parse('2099-07-31T00:00:00.000Z')
    });
    const first = await provider.readAuthorityBundle(query, new AbortController().signal);
    const second = await provider.readAuthorityBundle(
      { ...query, runId: 'run-2' },
      new AbortController().signal
    );

    expect(second?.bundleId).not.toBe(first?.bundleId);
    expect(second?.rootBudget.grantId).not.toBe(first?.rootBudget.grantId);
  });

  it('pins immutable inference preferences into the authority bundle', async () => {
    const provider = compileBootstrapAgentAdmissionAuthoritySource(enabledSource(), {
      now: () => Date.parse('2099-07-31T00:00:00.000Z')
    });

    await expect(provider.readAuthorityBundle({
      ...query,
      execution: {
        mode: 'agent',
        inference: { reasoningMode: 'on', reasoningEffort: 'high' }
      }
    }, new AbortController().signal)).resolves.toMatchObject({
      model: {
        inference: { reasoningMode: 'on', reasoningEffort: 'high' }
      }
    });
  });

  it('compiles plan execution into one exact read-only authority bundle', async () => {
    const source = enabledSource();
    const authority = source.manifests[0]!;
    authority.workspace.access = 'write';
    authority.capabilityGrant.capabilities = [
      { capabilityId: 'browser.use', scopeIds: ['scope.project'] },
      { capabilityId: 'mcp.use', scopeIds: ['scope.project'] },
      { capabilityId: 'workspace.read', scopeIds: ['scope.project'] },
      { capabilityId: 'workspace.shell', scopeIds: ['scope.project'] },
      { capabilityId: 'workspace.write', scopeIds: ['scope.project'] }
    ];
    authority.toolCatalog.allowedToolNames = [
      'browser.accessibility_snapshot',
      'browser.click',
      'browser.navigate',
      'browser.type',
      'browser.wait',
      'mcp.invoke',
      'workspace.list_files',
      'workspace.read_file',
      'workspace.run_shell',
      'workspace.write_file'
    ];
    authority.rootBudget.vector = {
      modelTurns: 8,
      toolCalls: 20,
      readCalls: 15,
      writeCalls: 4,
      shellCalls: 2,
      costMicrousd: 100_000
    };
    const provider = compileBootstrapAgentAdmissionAuthoritySource(source, {
      now: () => Date.parse('2099-07-31T00:00:00.000Z')
    });

    const bundle = await provider.readAuthorityBundle({
      ...query,
      execution: { mode: 'plan' }
    }, new AbortController().signal);

    expect(bundle).not.toBeNull();
    expect(bundle).toMatchObject({
      workspace: { access: 'read' },
      capabilityGrant: {
        capabilities: [
          { capabilityId: 'browser.use' },
          { capabilityId: 'workspace.read' }
        ]
      },
      toolCatalog: {
        allowedToolNames: [
          'browser.accessibility_snapshot',
          'browser.navigate',
          'browser.wait',
          'workspace.list_files',
          'workspace.read_file'
        ]
      },
      rootBudget: {
        vector: {
          writeCalls: 0,
          shellCalls: 0
        }
      }
    });
  });

  it('fails closed for disabled, unmatched, expired, and malformed sources', async () => {
    const disabled = compileBootstrapAgentAdmissionAuthoritySource({
      sourceVersion: 1,
      status: 'disabled',
      reason: 'not_configured'
    });
    await expect(disabled.readAuthorityBundle(query, new AbortController().signal))
      .resolves.toBeNull();

    const enabled = compileBootstrapAgentAdmissionAuthoritySource(enabledSource(), {
      now: () => Date.parse(future)
    });
    await expect(enabled.readAuthorityBundle(query, new AbortController().signal))
      .resolves.toBeNull();
    await expect(enabled.readAuthorityBundle(
      { ...query, workspaceId: 'workspace-missing' },
      new AbortController().signal
    )).resolves.toBeNull();

    const invalidClock = compileBootstrapAgentAdmissionAuthoritySource(enabledSource(), {
      now: () => Number.NaN
    });
    await expect(invalidClock.readAuthorityBundle(query, new AbortController().signal))
      .resolves.toBeNull();

    expect(() => compileBootstrapAgentAdmissionAuthoritySource({
      sourceVersion: 1,
      status: 'enabled',
      manifests: [{ ...manifest(), policy: { permissionMode: 'trusted' } }]
    })).toThrow();
  });

  it('snapshots the serializable source instead of retaining caller mutations', async () => {
    const source = enabledSource();
    const provider = compileBootstrapAgentAdmissionAuthoritySource(source, {
      now: () => Date.parse('2099-07-31T00:00:00.000Z')
    });
    source.manifests[0]!.model.modelId = 'mutated-after-compile';

    await expect(provider.readAuthorityBundle(query, new AbortController().signal))
      .resolves.toMatchObject({ model: { modelId: 'model-1' } });
  });
});

function enabledSource(): AgentAdmissionAuthoritySource & {
  status: 'enabled';
  manifests: AgentAdmissionAuthoritySourceManifest[];
} {
  return {
    sourceVersion: 1,
    status: 'enabled',
    manifests: [manifest()]
  };
}

function manifest(): AgentAdmissionAuthoritySourceManifest {
  return {
    manifestVersion: 1,
    manifestId: 'authority-manifest-1',
    revision: 7,
    workspace: {
      workspaceId: 'workspace-1',
      revision: 11,
      grantDigest: `sha256:${'b'.repeat(64)}`,
      access: 'write',
      scopeIds: ['scope.project']
    },
    model: {
      providerId: 'provider-1',
      modelId: 'model-1',
      settingsRevision: 13
    },
    policy: {
      policyId: 'policy-1',
      revision: 5,
      permissionMode: 'ask'
    },
    capabilityGrant: {
      grantId: 'capability-grant-1',
      revision: 3,
      capabilities: [{
        capabilityId: 'file-read',
        scopeIds: ['scope.project']
      }]
    },
    toolCatalog: {
      catalogId: 'tool-catalog-1',
      revision: 2,
      digest: `sha256:${'c'.repeat(64)}`,
      allowedToolNames: ['read_file']
    },
    rootBudget: {
      authorityId: 'root-budget-authority-1',
      revision: 17,
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
        deadlineAt: future
      }
    }
  };
}

import { fileURLToPath } from 'node:url';
import type { AgentTurnInput } from '@ariadne/agent-core';
import { describe, expect, it } from 'vitest';

import { AcpSubagentAgentEngine } from '../src/adapters/subagent/AcpSubagentAgentEngine.js';
import type {
  AgentProcessRequest,
  AgentProcessSandbox
} from '../src/control/ports/AgentProcessSandbox.js';
import { HostProcessSandbox } from '../src/sandbox/HostProcessSandbox.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/acp-test-agent.mjs', import.meta.url));
const WORKSPACE = process.cwd();

describe('AcpSubagentAgentEngine', () => {
  it('runs a fresh ACP process with only cwd and the delegated objective', async () => {
    const engine = new AcpSubagentAgentEngine({
      config: config(),
      workspaceRoots: new Map([['workspace-acp', WORKSPACE]]),
      sandboxForWorkspace: () => hostSandboxAdapter()
    });

    const prepared = await engine.prepare(input(), new AbortController().signal);
    expect(prepared.modelContext).toMatchObject({
      providerId: 'external.acp',
      transport: 'acp_stdio',
      inheritsParentContext: false,
      permissionPolicy: 'reject'
    });
    await expect(prepared.decide(new AbortController().signal)).resolves.toEqual({
      kind: 'respond',
      content: 'external:delegated objective only'
    });
  });

  it('rejects unattended ACP permission requests by default', async () => {
    const engine = new AcpSubagentAgentEngine({
      config: config(['permission']),
      workspaceRoots: new Map([['workspace-acp', WORKSPACE]]),
      sandboxForWorkspace: () => hostSandboxAdapter()
    });
    const prepared = await engine.prepare(input(), new AbortController().signal);

    await expect(prepared.decide(new AbortController().signal)).rejects.toMatchObject({
      code: 'AGENT_INFERENCE_DETERMINISTIC_FAILURE',
      providerErrorCode: 'acp_remote_cancelled'
    });
  });

  it('does not let an allow setting bypass ask-mode Child authority', async () => {
    const observedNetworkModes: string[] = [];
    const engine = new AcpSubagentAgentEngine({
      config: config(['permission'], 'allow', 'online-approved'),
      workspaceRoots: new Map([['workspace-acp', WORKSPACE]]),
      sandboxForWorkspace: () => hostSandboxAdapter((request) => {
        observedNetworkModes.push(request.networkMode);
      })
    });
    const prepared = await engine.prepare(input(), new AbortController().signal);

    expect(prepared.modelContext).toMatchObject({
      permissionPolicy: 'reject',
      allowedToolKinds: [],
      networkAccess: 'offline'
    });
    await expect(prepared.decide(new AbortController().signal)).rejects.toMatchObject({
      providerErrorCode: 'acp_remote_cancelled'
    });
    expect(observedNetworkModes).toEqual(['offline']);
  });

  it('allows only tool kinds covered by trusted frozen Child capabilities', async () => {
    const observedNetworkModes: string[] = [];
    const engine = new AcpSubagentAgentEngine({
      config: config(['permission'], 'allow', 'online-approved'),
      workspaceRoots: new Map([['workspace-acp', WORKSPACE]]),
      sandboxForWorkspace: () => hostSandboxAdapter((request) => {
        observedNetworkModes.push(request.networkMode);
      })
    });
    const prepared = await engine.prepare(input({
      permissionMode: 'trusted',
      capabilityIds: ['workspace.shell', 'browser.use']
    }), new AbortController().signal);

    expect(prepared.modelContext).toMatchObject({
      permissionPolicy: 'allow_authorized',
      allowedToolKinds: ['execute', 'fetch', 'think'],
      networkAccess: 'online-approved'
    });
    await expect(prepared.decide(new AbortController().signal)).resolves.toEqual({
      kind: 'respond',
      content: 'external:delegated objective only'
    });
    expect(observedNetworkModes).toEqual(['online-approved']);
  });
});

function config(
  args: readonly string[] = [],
  permissionPolicy: 'reject' | 'allow' = 'reject',
  networkAccess: 'offline' | 'online-approved' = 'offline'
) {
  return {
    kind: 'acp_stdio' as const,
    providerId: 'external.acp',
    displayName: 'External ACP test child',
    command: process.execPath,
    args: [FIXTURE, ...args],
    permissionPolicy,
    networkAccess,
    timeoutMs: 30_000,
    disposeGraceMs: 2_000
  };
}

function input(options: {
  readonly permissionMode?: 'ask' | 'trusted';
  readonly capabilityIds?: readonly string[];
} = {}): AgentTurnInput {
  return {
    run: {
      binding: {
        workspace: { workspaceId: 'workspace-acp', access: 'read' },
        policy: {
          policyId: 'policy-acp',
          revision: 1,
          permissionMode: options.permissionMode ?? 'ask'
        },
        capabilities: (options.capabilityIds ?? []).map((capabilityId) => ({
          capabilityId,
          scopeIds: ['workspace-acp']
        })),
        objectiveRef: {
          kind: 'parent_delegation',
          parentRunId: 'parent-acp',
          delegationId: 'delegation-acp',
          objectiveDigest: `sha256:${'a'.repeat(64)}`,
          mode: 'one_shot',
          providerId: 'external.acp'
        }
      }
    },
    messages: [
      { kind: 'text', role: 'system', content: 'parent-only system context' },
      { kind: 'text', role: 'user', content: 'delegated objective only' }
    ],
    availableTools: [{ tool: { toolName: 'parent.secret', revision: 1 } }]
  } as unknown as AgentTurnInput;
}

function hostSandboxAdapter(
  observe?: (request: AgentProcessRequest) => void
): AgentProcessSandbox {
  const host = new HostProcessSandbox();
  const danger = (request: AgentProcessRequest) => ({
    ...request,
    mode: 'danger-full-access' as const
  });
  return {
    mode: 'danger-full-access',
    runFile: (request) => host.runFile(danger(request)),
    openFileLease: (request, observer) => {
      observe?.(request);
      return host.openFileLease(danger(request), observer);
    }
  };
}

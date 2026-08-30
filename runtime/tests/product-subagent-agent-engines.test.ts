import { fileURLToPath } from 'node:url';
import type { AgentTurnInput } from '@ariadne/agent-core';
import { describe, expect, it } from 'vitest';

import {
  ClaudeSubagentAgentEngine,
  CodexSubagentAgentEngine
} from '../src/adapters/subagent/ProductSubagentAgentEngines.js';
import type { AgentProcessRequest, AgentProcessSandbox } from '../src/control/ports/AgentProcessSandbox.js';
import { HostProcessSandbox } from '../src/sandbox/HostProcessSandbox.js';

const CODEX_FIXTURE = fileURLToPath(new URL('./fixtures/codex-app-server-test-agent.mjs', import.meta.url));
const CLAUDE_FIXTURE = fileURLToPath(new URL('./fixtures/claude-code-test-agent.mjs', import.meta.url));
const WORKSPACE = process.cwd();

describe('product SubAgent engines', () => {
  it('runs Codex through its app-server JSON-RPC protocol inside the shared sandbox', async () => {
    const engine = new CodexSubagentAgentEngine({
      config: {
        kind: 'codex_app_server',
        providerId: 'external.codex',
        displayName: 'Codex test',
        command: process.execPath,
        args: [CODEX_FIXTURE],
        permissionPolicy: 'never',
        networkAccess: 'offline',
        timeoutMs: 30_000,
        disposeGraceMs: 2_000
      },
      workspaceRoots: new Map([['workspace-product', WORKSPACE]]),
      sandboxForWorkspace: () => hostSandbox()
    });
    const prepared = await engine.prepare(input('external.codex'), new AbortController().signal);
    expect(prepared.modelContext).toMatchObject({ transport: 'codex_app_server' });
    await expect(prepared.decide(new AbortController().signal)).resolves.toEqual({
      kind: 'respond',
      content: 'codex:delegated product objective'
    });
  });

  it('runs Claude Code in strict print/JSON mode inside the shared sandbox', async () => {
    const engine = new ClaudeSubagentAgentEngine({
      config: {
        kind: 'claude_code',
        providerId: 'external.claude',
        displayName: 'Claude test',
        command: process.execPath,
        args: [CLAUDE_FIXTURE],
        permissionPolicy: 'dontAsk',
        networkAccess: 'offline',
        timeoutMs: 30_000,
        disposeGraceMs: 2_000
      },
      workspaceRoots: new Map([['workspace-product', WORKSPACE]]),
      sandboxForWorkspace: () => hostSandbox()
    });
    const prepared = await engine.prepare(input('external.claude'), new AbortController().signal);
    expect(prepared.modelContext).toMatchObject({ transport: 'claude_code' });
    await expect(prepared.decide(new AbortController().signal)).resolves.toEqual({
      kind: 'respond',
      content: 'claude:delegated product objective'
    });
  });

  it('rejects continuable product children before starting a process', async () => {
    const engine = new CodexSubagentAgentEngine({
      config: {
        kind: 'codex_app_server',
        providerId: 'external.codex',
        displayName: 'Codex test',
        command: process.execPath,
        args: [CODEX_FIXTURE],
        permissionPolicy: 'never',
        networkAccess: 'offline',
        timeoutMs: 30_000,
        disposeGraceMs: 2_000
      },
      workspaceRoots: new Map([['workspace-product', WORKSPACE]]),
      sandboxForWorkspace: () => hostSandbox()
    });
    await expect(engine.prepare(
      input('external.codex', 'continuable'),
      new AbortController().signal
    )).rejects.toMatchObject({ providerErrorCode: 'codex_app_server_child_authority_invalid' });
  });
});

function input(providerId: string, mode: 'one_shot' | 'continuable' = 'one_shot'): AgentTurnInput {
  return {
    run: {
      runId: 'child-product',
      binding: {
        workspace: { workspaceId: 'workspace-product', access: 'read' },
        objectiveRef: {
          kind: 'parent_delegation',
          parentRunId: 'parent-product',
          delegationId: 'delegation-product',
          objectiveDigest: `sha256:${'a'.repeat(64)}`,
          mode,
          providerId
        }
      }
    },
    messages: [
      { kind: 'text', role: 'system', content: 'parent-only context' },
      { kind: 'text', role: 'user', content: 'delegated product objective' }
    ],
    availableTools: []
  } as unknown as AgentTurnInput;
}

function hostSandbox(): AgentProcessSandbox {
  const host = new HostProcessSandbox();
  const danger = (request: AgentProcessRequest) => ({
    ...request,
    mode: 'danger-full-access' as const
  });
  return {
    mode: 'danger-full-access',
    runFile: (request) => host.runFile(danger(request)),
    openFileLease: (request, observer) => host.openFileLease(danger(request), observer)
  };
}

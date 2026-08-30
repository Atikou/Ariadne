import { resolve } from 'node:path';
import type { AgentTurnInput } from '@ariadne/agent-core';

import {
  ClaudeSubagentAgentEngine,
  CodexSubagentAgentEngine
} from '../adapters/subagent/ProductSubagentAgentEngines.js';
import type {
  AgentProcessExecutionResult,
  AgentProcessLease,
  AgentProcessRequest,
  AgentProcessSandbox
} from '../control/ports/AgentProcessSandbox.js';
import { HostProcessSandbox } from '../sandbox/HostProcessSandbox.js';

async function main(): Promise<void> {
  const target = argument('--target');
  const command = resolve(argument('--command'));
  const workspaceRoot = resolve(optionalArgument('--workspace') ?? process.cwd());
  const sandbox = hostSandboxAdapter();
  const common = {
    providerId: `accept.${target}`,
    displayName: `${target} acceptance`,
    command,
    args: [],
    networkAccess: 'online-approved' as const,
    timeoutMs: 5 * 60_000,
    disposeGraceMs: 6_000
  };
  const engine = target === 'codex'
    ? new CodexSubagentAgentEngine({
        config: { ...common, kind: 'codex_app_server', permissionPolicy: 'never' },
        workspaceRoots: new Map([['accept-workspace', workspaceRoot]]),
        sandboxForWorkspace: () => sandbox
      })
    : target === 'claude'
      ? new ClaudeSubagentAgentEngine({
          config: { ...common, kind: 'claude_code', permissionPolicy: 'dontAsk' },
          workspaceRoots: new Map([['accept-workspace', workspaceRoot]]),
          sandboxForWorkspace: () => sandbox
        })
      : throwUsage();
  const input = acceptanceInput(`accept.${target}`);
  const prepared = await engine.prepare(input, new AbortController().signal);
  const directive = await prepared.decide(new AbortController().signal);
  if (directive.kind !== 'respond' || directive.content.trim().length === 0) {
    throw new Error('Product SubAgent did not return a non-empty response.');
  }
  process.stdout.write(`${JSON.stringify({
    accepted: true,
    target,
    transport: target === 'codex' ? 'codex_app_server' : 'claude_code',
    responseCharacters: directive.content.length
  })}\n`);
}

function hostSandboxAdapter(): AgentProcessSandbox {
  const host = new HostProcessSandbox();
  const danger = (request: AgentProcessRequest) => {
    const { args, ...rest } = request;
    return {
      ...rest,
      args: args === undefined ? [] : [...args],
      mode: 'danger-full-access' as const
    };
  };
  return {
    mode: 'danger-full-access',
    runFile: async (request) => normalizeHostResult(await host.runFile(danger(request))),
    openFileLease: (request, observer): AgentProcessLease => {
      const lease = host.openFileLease(danger(request), observer);
      return {
        executionId: lease.executionId,
        completion: lease.completion.then(normalizeHostResult),
        cancel: () => lease.cancel(),
        writeStdin: (chunk) => lease.writeStdin(chunk),
        endStdin: () => lease.endStdin(),
        signal: (signal) => lease.signal(signal)
      };
    }
  };
}

function normalizeHostResult(
  result: Awaited<ReturnType<HostProcessSandbox['runFile']>>
): AgentProcessExecutionResult {
  return {
    executionId: result.executionId,
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    truncated: result.truncated,
    spawnFailed: result.spawnFailed,
    ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
    isolation: {
      ...result.isolation,
      backend: result.isolation.backend === 'windows-native' ? 'windows-native' : 'host'
    }
  };
}

function acceptanceInput(providerId: string): AgentTurnInput {
  return {
    run: {
      runId: 'accept-product-child',
      binding: {
        workspace: { workspaceId: 'accept-workspace', access: 'read' },
        objectiveRef: {
          kind: 'parent_delegation',
          parentRunId: 'accept-product-parent',
          delegationId: 'accept-product-delegation',
          objectiveDigest: `sha256:${'a'.repeat(64)}`,
          mode: 'one_shot',
          providerId
        }
      }
    },
    messages: [{
      kind: 'text',
      role: 'user',
      content: 'Reply with one short sentence confirming this product SubAgent turn completed.'
    }],
    availableTools: []
  } as unknown as AgentTurnInput;
}

function argument(name: string): string {
  const value = optionalArgument(name);
  if (value === undefined) throwUsage();
  return value;
}

function optionalArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function throwUsage(): never {
  throw new Error(
    'Usage: accept-subagent-provider --target codex|claude --command <absolute executable> [--workspace <path>]'
  );
}

await main();

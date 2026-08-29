import path from 'node:path';

import {
  ARIADNE_RUNTIME_PROTOCOL,
  ARIADNE_RUNTIME_PROTOCOL_VERSION,
  type RuntimeBootstrap
} from '@ariadne/protocol/host';
import { createDefaultRuntimePolicySnapshot } from '@ariadne/protocol/settings';
import { describe, expect, it } from 'vitest';

import type { AgentProcessSandbox } from '../src/control/ports/AgentProcessSandbox.js';
import { compileProductionRuntimeCapabilityManifest } from '../src/composition/ProductionRuntimeCapabilityManifest.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';
import { HostProcessSandbox } from '../src/sandbox/HostProcessSandbox.js';

describe('persistent process Tool integration', () => {
  it('continues one real process through producer and shared job control Effects', async () => {
    const bootstrap = createBootstrap();
    const manifest = await compileProductionRuntimeCapabilityManifest({
      bootstrap,
      processSandboxFactory: () => new HostProcessSandbox() as unknown as AgentProcessSandbox
    });
    const catalog = manifest.agentToolCatalogSnapshots[0]!;
    const tool = (name: string) => catalog.entries.find(
      (entry) => entry.document.toolName === name
    )!;
    const baseContext = {
      runId: 'run-persistent-process',
      capabilityIds: ['workspace.shell'],
      scope: ['workspace-process'],
      signal: new AbortController().signal
    };
    const script = [
      "const readline=require('node:readline')",
      "const rl=readline.createInterface({input:process.stdin})",
      "console.log('READY')",
      "rl.on('line',(line)=>{console.log('ECHO:'+line);if(line==='quit')process.exit(0)})"
    ].join(';');

    try {
      const started = await tool('workspace.process_start').executable.execute({
        command: process.execPath,
        args: ['-e', script]
      }, {
        ...baseContext,
        effectId: 'effect-process-start',
        toolCallId: 'call-process-start',
        idempotencyKey: 'idempotency-process-start'
      });
      expect(started.status).toBe('succeeded');
      const jobId = resultRecord(started).jobId;
      expect(typeof jobId).toBe('string');

      await expect(tool('workspace.job_list').executable.execute({}, {
        ...baseContext,
        effectId: 'effect-job-list',
        toolCallId: 'call-job-list',
        idempotencyKey: 'idempotency-job-list'
      })).resolves.toMatchObject({
        status: 'succeeded',
        result: { jobs: [expect.objectContaining({ jobId, kind: 'process', status: 'running' })] }
      });

      await waitForOutput(async () => await tool('workspace.job_output').executable.execute({
        jobId
      }, {
        ...baseContext,
        effectId: 'effect-process-read-ready',
        toolCallId: 'call-process-read-ready',
        idempotencyKey: 'idempotency-process-read-ready'
      }), 'READY');

      await expect(tool('workspace.job_write').executable.execute({
        jobId,
        text: 'hello'
      }, {
        ...baseContext,
        effectId: 'effect-process-write',
        toolCallId: 'call-process-write',
        idempotencyKey: 'idempotency-process-write'
      })).resolves.toMatchObject({ status: 'succeeded' });

      const echoed = await waitForOutput(async () => await tool('workspace.job_output')
        .executable.execute({ jobId }, {
          ...baseContext,
          effectId: 'effect-process-read-echo',
          toolCallId: 'call-process-read-echo',
          idempotencyKey: 'idempotency-process-read-echo'
        }), 'ECHO:hello');
      expect(echoed).toContain('READY');

      await expect(tool('workspace.job_kill').executable.execute({ jobId }, {
        ...baseContext,
        effectId: 'effect-process-stop',
        toolCallId: 'call-process-stop',
        idempotencyKey: 'idempotency-process-stop'
      })).resolves.toMatchObject({ status: 'succeeded', result: { status: 'killed' } });

      await expect(tool('workspace.job_wait').executable.execute({ jobId, timeoutMs: 100 }, {
        ...baseContext,
        effectId: 'effect-job-wait',
        toolCallId: 'call-job-wait',
        idempotencyKey: 'idempotency-job-wait'
      })).resolves.toMatchObject({
        status: 'succeeded',
        result: { completed: true, job: { jobId, status: 'killed' } }
      });
    } finally {
      const shutdown = createShutdownContext(Date.now() + 5_000);
      try {
        await manifest.close(shutdown);
      } finally {
        shutdown.dispose();
      }
    }
  }, 10_000);

  it.skipIf(process.platform !== 'win32')(
    'hosts a real PTY inside the sandbox and controls it through generic job Effects',
    async () => {
      const bootstrap = createBootstrap();
      const manifest = await compileProductionRuntimeCapabilityManifest({
        bootstrap,
        processSandboxFactory: () => new HostProcessSandbox() as unknown as AgentProcessSandbox
      });
      const catalog = manifest.agentToolCatalogSnapshots[0]!;
      const tool = (name: string) => catalog.entries.find(
        (entry) => entry.document.toolName === name
      )!;
      const baseContext = {
        runId: 'run-persistent-terminal',
        capabilityIds: ['workspace.shell'],
        scope: ['workspace-process'],
        signal: new AbortController().signal
      };
      const script = [
        "const readline=require('node:readline')",
        "const rl=readline.createInterface({input:process.stdin})",
        "process.on('SIGINT',()=>console.log('INTERRUPTED'))",
        "console.log('TERMINAL_READY')",
        "rl.on('line',(line)=>console.log('TERMINAL_ECHO:'+line))"
      ].join(';');

      try {
        const started = await tool('workspace.terminal_start').executable.execute({
          command: process.execPath,
          args: ['-e', script],
          columns: 100,
          rows: 24
        }, {
          ...baseContext,
          effectId: 'effect-terminal-start',
          toolCallId: 'call-terminal-start',
          idempotencyKey: 'idempotency-terminal-start'
        });
        expect(started).toMatchObject({
          status: 'succeeded',
          result: {
            kind: 'terminal',
            status: 'running',
            capabilities: { input: true, resize: true, signal: true }
          }
        });
        const jobId = resultRecord(started).jobId;

        await waitForOutput(async () => await tool('workspace.job_output').executable.execute({
          jobId
        }, {
          ...baseContext,
          effectId: 'effect-terminal-ready',
          toolCallId: 'call-terminal-ready',
          idempotencyKey: 'idempotency-terminal-ready'
        }), 'TERMINAL_READY');

        await expect(tool('workspace.job_resize').executable.execute({
          jobId,
          columns: 132,
          rows: 40
        }, {
          ...baseContext,
          effectId: 'effect-terminal-resize',
          toolCallId: 'call-terminal-resize',
          idempotencyKey: 'idempotency-terminal-resize'
        })).resolves.toMatchObject({ status: 'succeeded' });

        await expect(tool('workspace.job_write').executable.execute({
          jobId,
          text: 'hello-terminal'
        }, {
          ...baseContext,
          effectId: 'effect-terminal-write',
          toolCallId: 'call-terminal-write',
          idempotencyKey: 'idempotency-terminal-write'
        })).resolves.toMatchObject({ status: 'succeeded' });

        await waitForOutput(async () => await tool('workspace.job_output').executable.execute({
          jobId
        }, {
          ...baseContext,
          effectId: 'effect-terminal-echo',
          toolCallId: 'call-terminal-echo',
          idempotencyKey: 'idempotency-terminal-echo'
        }), 'TERMINAL_ECHO:hello-terminal');

        await expect(tool('workspace.job_signal').executable.execute({
          jobId,
          signal: 'interrupt'
        }, {
          ...baseContext,
          effectId: 'effect-terminal-interrupt',
          toolCallId: 'call-terminal-interrupt',
          idempotencyKey: 'idempotency-terminal-interrupt'
        })).resolves.toMatchObject({ status: 'succeeded' });

        await expect(tool('workspace.job_kill').executable.execute({ jobId }, {
          ...baseContext,
          effectId: 'effect-terminal-kill',
          toolCallId: 'call-terminal-kill',
          idempotencyKey: 'idempotency-terminal-kill'
        })).resolves.toMatchObject({ status: 'succeeded', result: { status: 'killed' } });
      } finally {
        const shutdown = createShutdownContext(Date.now() + 5_000);
        try {
          await manifest.close(shutdown);
        } finally {
          shutdown.dispose();
        }
      }
    },
    20_000
  );
});

async function waitForOutput(
  read: () => Promise<unknown>,
  expected: string
): Promise<string> {
  const deadline = Date.now() + 8_000;
  do {
    const outcome = await read();
    const result = resultRecord(outcome);
    const chunks = Array.isArray(result.chunks) ? result.chunks : [];
    const text = chunks.map((chunk) => (
      typeof chunk === 'object' && chunk !== null && 'text' in chunk
        ? String(chunk.text)
        : ''
    )).join('');
    if (text.includes(expected)) return text;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error(`persistent_process_output_timeout:${expected}`);
}

function resultRecord(value: unknown): Record<string, unknown> {
  if (
    typeof value !== 'object' || value === null
    || !('result' in value)
    || typeof value.result !== 'object' || value.result === null
    || Array.isArray(value.result)
  ) throw new Error('tool_result_missing');
  return value.result as Record<string, unknown>;
}

function createBootstrap(): RuntimeBootstrap {
  return {
    protocol: ARIADNE_RUNTIME_PROTOCOL,
    protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
    runtimeInstanceId: '00000000-0000-4000-8000-000000000073',
    type: 'bootstrap',
    appVersion: '0.1.0',
    runtimeVersion: '0.1.0',
    runtimeBuildFingerprint: 'b'.repeat(64),
    installRoot: path.resolve('.'),
    dataRoot: path.resolve('.'),
    modelRoots: [],
    agentPermissions: {
      approvalPolicy: 'request',
      proposalApproval: 'manual',
      permissionPolicy: 'confirmBeforeRun',
      sandboxMode: 'danger-full-access',
      allowedPermissions: ['read', 'write', 'shell']
    },
    agentAdmissionAuthoritySource: {
      sourceVersion: 1,
      status: 'disabled',
      reason: 'not_configured'
    },
    runtimePolicy: createDefaultRuntimePolicySnapshot(),
    profile: 'test',
    workspaces: [{
      workspaceId: 'workspace-process',
      label: 'Process workspace',
      rootPath: path.resolve('.'),
      access: 'write'
    }],
    production: false
  };
}

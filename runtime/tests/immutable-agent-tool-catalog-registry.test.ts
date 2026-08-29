import { createHash } from 'node:crypto';

import {
  AgentRunInvariantError,
  type AgentEffectExecutor,
  type AgentPinnedToolIdentity,
  type AgentToolJsonValue
} from '@ariadne/agent-core';
import { describe, expect, it, vi } from 'vitest';

import { ImmutableAgentToolCatalogRegistry } from '../src/adapters/tool/ImmutableAgentToolCatalogRegistry.js';
import {
  compileTrustedAgentToolCatalog,
  type TrustedAgentToolCatalogSnapshot
} from '../src/adapters/tool/TrustedAgentToolCatalogCompiler.js';
import type {
  AgentProtectedEffectResultReader,
  AgentToolContractDocumentV2,
  AgentToolExecutableImplementationV1
} from '../src/control/ports/AgentToolExecution.js';

describe('ImmutableAgentToolCatalogRegistry', () => {
  it('returns only the exact compiler-verified catalog identity', async () => {
    const snapshot = catalogSnapshot();
    const registry = new ImmutableAgentToolCatalogRegistry([snapshot]);
    const signal = new AbortController().signal;
    const exact = {
      referenceVersion: 1 as const,
      catalogId: snapshot.catalogId,
      revision: snapshot.revision,
      digest: snapshot.catalogDigest
    };

    await expect(registry.readToolCatalog(exact, signal)).resolves.not.toBeNull();
    expect(registry.hasExactCatalog(exact)).toBe(true);
    await expect(registry.readToolCatalog({
      ...exact,
      revision: exact.revision + 1
    }, signal)).resolves.toBeNull();
    expect(registry.hasExactCatalog({
      ...exact,
      revision: exact.revision + 1
    })).toBe(false);
    await expect(registry.readToolCatalog({
      ...exact,
      digest: `sha256:${'f'.repeat(64)}`
    }, signal)).resolves.toBeNull();
  });

  it('allows an explicitly empty registry and never invents a default catalog', async () => {
    const registry = new ImmutableAgentToolCatalogRegistry();
    await expect(registry.readToolCatalog({
      referenceVersion: 1,
      catalogId: 'missing-catalog',
      revision: 1,
      digest: `sha256:${'a'.repeat(64)}`
    }, new AbortController().signal)).resolves.toBeNull();
  });

  it('rejects duplicate identities and untrusted catalog-shaped objects', () => {
    const snapshot = catalogSnapshot();
    expect(() => new ImmutableAgentToolCatalogRegistry([snapshot, snapshot]))
      .toThrow(AgentRunInvariantError);
    expect(() => new ImmutableAgentToolCatalogRegistry([{
      ...snapshot,
      entries: snapshot.entries
    } as TrustedAgentToolCatalogSnapshot])).toThrow(AgentRunInvariantError);
  });

  it('rejects accessor-backed references and observes cancellation', async () => {
    const snapshot = catalogSnapshot();
    const registry = new ImmutableAgentToolCatalogRegistry([snapshot]);
    const accessor = {
      referenceVersion: 1 as const,
      get catalogId() { return snapshot.catalogId; },
      revision: snapshot.revision,
      digest: snapshot.catalogDigest
    };
    await expect(registry.readToolCatalog(
      accessor,
      new AbortController().signal
    )).rejects.toThrow(AgentRunInvariantError);

    const controller = new AbortController();
    controller.abort(new Error('cancelled-before-catalog-read'));
    await expect(registry.readToolCatalog({
      referenceVersion: 1,
      catalogId: snapshot.catalogId,
      revision: snapshot.revision,
      digest: snapshot.catalogDigest
    }, controller.signal)).rejects.toThrow('cancelled-before-catalog-read');
  });

  it('executes prepared input through the exact compiler-verified Tool pin', async () => {
    const validatePrepared = vi.fn((input: AgentToolJsonValue) => ({
      status: 'accepted' as const,
      input
    }));
    const execute = vi.fn(async () => ({
      status: 'succeeded' as const,
      outputRef: 'artifact:workspace-read',
      result: { content: 'ok' }
    }));
    const executable = toolExecutable({ validatePrepared, execute });
    const snapshot = catalogSnapshot(executable);
    const registry: AgentEffectExecutor = new ImmutableAgentToolCatalogRegistry([
      snapshot
    ]);
    const tool = exactTool(snapshot);
    const signal = new AbortController().signal;

    await expect(registry.execute(executionRequest(tool), signal)).resolves.toEqual({
      status: 'succeeded',
      outputRef: 'artifact:workspace-read',
      result: { content: 'ok' }
    });
    expect(validatePrepared).toHaveBeenCalledWith({ path: 'src/readme.md' });
    expect(execute).toHaveBeenCalledWith(
      { path: 'src/readme.md' },
      {
        runId: 'run-registry',
        effectId: 'effect-registry',
        toolCallId: 'tool-call-registry',
        idempotencyKey: 'run-registry:tool-call-registry',
        capabilityIds: ['workspace.read'],
        scope: ['src'],
        signal
      }
    );
  });

  it('resolves public-static presentation only through the complete pinned identity', () => {
    const snapshot = catalogSnapshot();
    const registry = new ImmutableAgentToolCatalogRegistry([snapshot]);
    const tool = exactTool(snapshot);

    expect(registry.resolveToolPresentation(tool)).toEqual({
      kind: 'file_read',
      label: '读取工作区文件'
    });
    expect(registry.resolveToolPresentation({
      ...tool,
      revision: tool.revision + 1
    })).toBeNull();
  });

  it('injects the protected Effect result service only at Tool execution time', async () => {
    const reader: AgentProtectedEffectResultReader = {
      read: vi.fn(async () => ({
        effectId: 'effect-source',
        toolCallId: 'tool-call-source',
        status: 'succeeded',
        digest: `sha256:${'a'.repeat(64)}`,
        cursor: 0,
        nextCursor: 2,
        totalBytes: 2,
        content: '{}',
        complete: true
      }))
    };
    const execute = vi.fn(async () => ({
      status: 'succeeded' as const,
      result: { content: 'ok' }
    }));
    const snapshot = catalogSnapshot(toolExecutable({ execute }));
    const registry = new ImmutableAgentToolCatalogRegistry(
      [snapshot],
      undefined,
      { protectedEffectResults: reader }
    );
    const signal = new AbortController().signal;

    await registry.execute(executionRequest(exactTool(snapshot)), signal);

    expect(execute).toHaveBeenCalledWith(
      { path: 'src/readme.md' },
      expect.objectContaining({
        runId: 'run-registry',
        effectId: 'effect-registry',
        protectedEffectResults: reader,
        signal
      })
    );
  });

  it('rejects every complete Tool identity drift without validating or executing', async () => {
    const validatePrepared = vi.fn((input: AgentToolJsonValue) => ({
      status: 'accepted' as const,
      input
    }));
    const execute = vi.fn(async () => ({
      status: 'succeeded' as const,
      result: { content: 'wrong-tool' }
    }));
    const snapshot = catalogSnapshot(toolExecutable({ validatePrepared, execute }));
    const registry = new ImmutableAgentToolCatalogRegistry([snapshot]);
    const tool = exactTool(snapshot);
    const drifts: readonly (readonly [
      keyof AgentPinnedToolIdentity,
      string | number
    ])[] = [
      ['catalogId', 'workspace-tools-other'],
      ['revision', tool.revision + 1],
      ['digest', `sha256:${'f'.repeat(64)}`],
      ['toolName', 'workspace.read-other'],
      ['toolVersion', '2.0.0'],
      ['providerId', 'ariadne.workspace-other'],
      ['contractDigest', `sha256:${'e'.repeat(64)}`]
    ];

    for (const [field, value] of drifts) {
      await expect(registry.execute({
        ...executionRequest(tool),
        tool: { ...tool, [field]: value }
      }, new AbortController().signal)).rejects.toThrow(
        'complete compiler-verified pinned Tool identity'
      );
    }
    expect(validatePrepared).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails closed when prepared input is rejected and never invokes Tool I/O', async () => {
    const validatePrepared = vi.fn(() => ({ status: 'rejected' as const }));
    const execute = vi.fn(async () => ({
      status: 'succeeded' as const,
      result: { content: 'must-not-run' }
    }));
    const snapshot = catalogSnapshot(toolExecutable({ validatePrepared, execute }));
    const registry = new ImmutableAgentToolCatalogRegistry([snapshot]);

    await expect(registry.execute(
      executionRequest(exactTool(snapshot)),
      new AbortController().signal
    )).rejects.toThrow(
      'Durable Effect input no longer satisfies the pinned Tool contract.'
    );
    expect(validatePrepared).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it('cancels only before Tool I/O and preserves execution exceptions for recovery', async () => {
    const validatePrepared = vi.fn((input: AgentToolJsonValue) => ({
      status: 'accepted' as const,
      input
    }));
    const providerFailure = new Error('provider outcome is not durably known');
    const execute = vi.fn(async () => {
      throw providerFailure;
    });
    const snapshot = catalogSnapshot(toolExecutable({ validatePrepared, execute }));
    const registry = new ImmutableAgentToolCatalogRegistry([snapshot]);
    const request = executionRequest(exactTool(snapshot));
    const cancelled = new AbortController();
    cancelled.abort();

    await expect(registry.execute(request, cancelled.signal)).resolves.toEqual({
      status: 'cancelled',
      reason: 'effect_execution_cancelled_before_tool_io'
    });
    expect(validatePrepared).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();

    await expect(registry.execute(
      request,
      new AbortController().signal
    )).rejects.toBe(providerFailure);
    expect(validatePrepared).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

function catalogSnapshot(
  executable: AgentToolExecutableImplementationV1 = toolExecutable()
): TrustedAgentToolCatalogSnapshot {
  return compileTrustedAgentToolCatalog({
    catalogId: 'workspace-tools-v3',
    revision: 1,
    tools: [{ document: toolDocument(executable.artifacts), executable }]
  });
}

function toolDocument(
  artifacts: AgentToolExecutableImplementationV1['artifacts']
): AgentToolContractDocumentV2 {
  return {
    documentVersion: 2,
    toolName: 'workspace.read',
    toolVersion: '1.0.0',
    providerId: 'ariadne.workspace',
    model: {
      description: 'Read one approved Workspace file.',
      guidance: ['Use the exact Workspace-relative path.']
    },
    presentation: {
      kind: 'file_read',
      label: '读取工作区文件',
      resultVisibility: 'protected'
    },
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    capabilityIds: ['workspace.read'],
    requiredWorkspaceAccess: 'read',
    permission: { authority: 'run_grant', approval: 'never' },
    scopeSemantics: 'all_requested_workspace_scopes_must_be_granted',
    resourceSemantics: 'workspace_relative_path',
    lifecycleSemantics: 'bounded_invocation',
    sideEffect: 'read',
    idempotency: 'idempotency_key_required',
    recovery: 'retry_same_idempotency_key',
    timeoutMs: 1_000,
    implementationArtifacts: {
      providerDigest: digest(artifacts.provider),
      normalizerDigest: digest(artifacts.normalizer),
      preparedValidatorDigest: digest(artifacts.preparedValidator),
      executeDigest: digest(artifacts.execute)
    }
  };
}

function toolExecutable(
  overrides: Partial<AgentToolExecutableImplementationV1> = {}
): AgentToolExecutableImplementationV1 {
  const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
  const executable: AgentToolExecutableImplementationV1 = {
    artifacts: {
      provider: bytes('workspace-read-provider-v1'),
      normalizer: bytes('workspace-read-normalizer-v1'),
      preparedValidator: bytes('workspace-read-validator-v1'),
      execute: bytes('workspace-read-execute-v1')
    },
    normalizeAndValidate: (input) => ({ status: 'accepted', input }),
    validatePrepared: (input) => ({ status: 'accepted', input }),
    execute: async () => ({
      status: 'succeeded',
      result: { content: 'ok' }
    })
  };
  return {
    ...executable,
    ...overrides,
    artifacts: overrides.artifacts ?? executable.artifacts
  };
}

function exactTool(
  snapshot: TrustedAgentToolCatalogSnapshot
): AgentPinnedToolIdentity {
  const tool = snapshot.entries[0]?.tool;
  if (tool === undefined) throw new Error('test catalog must contain one Tool');
  return tool;
}

function executionRequest(
  tool: AgentPinnedToolIdentity
): Parameters<AgentEffectExecutor['execute']>[0] {
  return {
    runId: 'run-registry',
    effectId: 'effect-registry',
    toolCallId: 'tool-call-registry',
    tool,
    idempotencyKey: 'run-registry:tool-call-registry',
    capabilityIds: ['workspace.read'],
    scope: ['src'],
    input: { path: 'src/readme.md' }
  };
}

function digest(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

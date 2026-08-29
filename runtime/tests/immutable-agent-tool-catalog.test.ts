import { createHash } from 'node:crypto';

import {
  type AgentPinnedToolIdentity,
  type AgentRun,
  type AgentToolAdmissionRequest,
  type AgentToolJsonValue
} from '@ariadne/agent-core';
import { describe, expect, it, vi } from 'vitest';

import { ImmutableAgentToolCatalog } from '../src/adapters/tool/ImmutableAgentToolCatalog.js';
import {
  compileTrustedAgentToolCatalog,
  type TrustedAgentToolCatalogSnapshot
} from '../src/adapters/tool/TrustedAgentToolCatalogCompiler.js';
import type {
  AgentToolContractDocumentV2,
  AgentToolExecutableImplementationV1
} from '../src/control/ports/AgentToolExecution.js';

describe('ImmutableAgentToolCatalog', () => {
  it('returns policy-owned normalized input and compiler-derived authority', async () => {
    const { catalog, tool } = trustedCatalog();

    await expect(catalog.admit(request(tool))).resolves.toEqual({
      status: 'allow',
      tool,
      capabilityIds: ['workspace.write'],
      scope: ['src'],
      normalizedInput: { path: 'src/result.ts' }
    });
    expect(catalog.availableTools()).toEqual([{
      tool,
      capabilityIds: ['workspace.write']
    }]);
  });

  it('fails closed for catalog, capability, workspace, scope, and input drift', async () => {
    const { catalog, tool } = trustedCatalog();
    const base = request(tool);

    await expect(catalog.admit(request(tool, {
      run: {
        ...base.run,
        binding: {
          ...base.run.binding,
          toolCatalog: { ...base.run.binding.toolCatalog, revision: 8 }
        }
      }
    }))).resolves.toEqual({ status: 'deny', reason: 'catalog_mismatch' });
    await expect(catalog.admit(request(tool, {
      invocation: { ...base.invocation, capabilityIds: ['workspace.read'] }
    }))).resolves.toEqual({ status: 'deny', reason: 'tool_identity_mismatch' });
    await expect(catalog.admit(request(tool, {
      run: {
        ...base.run,
        binding: {
          ...base.run.binding,
          workspace: { ...base.run.binding.workspace, access: 'read' }
        }
      }
    }))).resolves.toEqual({ status: 'deny', reason: 'workspace_access_denied' });
    await expect(catalog.admit(request(tool, {
      invocation: { ...base.invocation, scope: ['other'] }
    }))).resolves.toEqual({ status: 'deny', reason: 'scope_denied' });
    await expect(catalog.admit(request(tool, {
      invocation: { ...base.invocation, input: { path: 42 } }
    }))).resolves.toEqual({ status: 'deny', reason: 'input_invalid' });
  });

  it('derives a durable permission wait from the trusted contract document', async () => {
    const { catalog, tool } = trustedCatalog({
      document: { permission: { authority: 'run_grant', approval: 'required' } }
    });
    await expect(catalog.admit(request(tool))).resolves.toMatchObject({ status: 'wait' });
  });

  it('does not disguise normalizer infrastructure failure as invalid model input', async () => {
    const { catalog, tool } = trustedCatalog({
      executable: {
        normalizeAndValidate: () => {
          throw new Error('normalizer_infrastructure_failed');
        }
      }
    });
    await expect(catalog.admit(request(tool))).rejects.toThrow(
      'normalizer_infrastructure_failed'
    );
  });

  it('executes only the exact pin and already-normalized durable input', async () => {
    const normalizeAndValidate = vi.fn((input: AgentToolJsonValue) => ({
      status: 'accepted' as const,
      input: normalizeInput(input)
    }));
    const validatePrepared = vi.fn((input: AgentToolJsonValue) => ({
      status: 'accepted' as const,
      input: validatePreparedInput(input)
    }));
    const execute = vi.fn(async () => ({
      status: 'succeeded' as const,
      result: { written: true }
    }));
    const { catalog, tool } = trustedCatalog({
      executable: { normalizeAndValidate, validatePrepared, execute }
    });
    const signal = new AbortController().signal;
    const effectRequest = executionRequest(tool);

    await expect(catalog.execute(effectRequest, signal)).resolves.toEqual({
      status: 'succeeded',
      result: { written: true }
    });
    expect(normalizeAndValidate).not.toHaveBeenCalled();
    expect(validatePrepared).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      { path: 'src/result.ts' },
      expect.objectContaining({ runId: 'run-tool', effectId: 'effect-tool', signal })
    );
    await expect(catalog.execute({
      ...effectRequest,
      tool: { ...tool, toolVersion: '4.0.0' }
    }, signal)).rejects.toThrow('exact immutable Tool identity');
    await expect(catalog.execute({
      ...effectRequest,
      input: { path: ' src/result.ts ' }
    }, signal)).rejects.toThrow('already equal');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(normalizeAndValidate).not.toHaveBeenCalled();
    expect(validatePrepared).toHaveBeenCalledTimes(2);
  });

  it('snapshots admission authority before a normalizer closure mutates the request', async () => {
    let sourceRequest: AgentToolAdmissionRequest;
    const normalizeAndValidate = vi.fn((input: AgentToolJsonValue) => {
      const mutable = sourceRequest.invocation as unknown as {
        capabilityIds: string[];
        scope: string[];
        input: { path: string };
      };
      mutable.capabilityIds[0] = 'workspace.read';
      mutable.scope[0] = 'other';
      mutable.input.path = 'outside/escape.ts';
      return { status: 'accepted' as const, input: normalizeInput(input) };
    });
    const { catalog, tool } = trustedCatalog({ executable: { normalizeAndValidate } });
    sourceRequest = request(tool);

    await expect(catalog.admit(sourceRequest)).resolves.toMatchObject({
      status: 'allow',
      capabilityIds: ['workspace.write'],
      scope: ['src'],
      normalizedInput: { path: 'src/result.ts' }
    });
    expect(sourceRequest.invocation.capabilityIds).toEqual(['workspace.read']);
    expect(sourceRequest.invocation.scope).toEqual(['other']);
  });

  it('rejects a prepared validator that mutates its validation input in place', async () => {
    const execute = vi.fn(async () => ({ status: 'succeeded' as const }));
    const { catalog, tool } = trustedCatalog({
      executable: {
        validatePrepared: (input) => {
          (input as { path: string }).path = 'outside/escape.ts';
          return { status: 'accepted', input };
        },
        execute
      }
    });

    await expect(catalog.execute(
      executionRequest(tool),
      new AbortController().signal
    )).rejects.toThrow('already equal');
    expect(execute).not.toHaveBeenCalled();
  });

  it('snapshots execution authority before a validator closure mutates the request', async () => {
    let sourceRequest: ReturnType<typeof executionRequest>;
    const execute = vi.fn(async (_input, context) => {
      expect(context.capabilityIds).toEqual(['workspace.write']);
      expect(context.scope).toEqual(['src']);
      return { status: 'succeeded' as const };
    });
    const { catalog, tool } = trustedCatalog({
      executable: {
        validatePrepared: (input) => {
          sourceRequest.capabilityIds[0] = 'workspace.read';
          sourceRequest.scope[0] = 'other';
          return { status: 'accepted', input: validatePreparedInput(input) };
        },
        execute
      }
    });
    sourceRequest = executionRequest(tool);

    await expect(catalog.execute(
      sourceRequest,
      new AbortController().signal
    )).resolves.toMatchObject({ status: 'succeeded' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('returns cancelled before validation or tool I/O for an already-aborted signal', async () => {
    const validatePrepared = vi.fn((input: AgentToolJsonValue) => ({
      status: 'accepted' as const,
      input
    }));
    const execute = vi.fn(async () => ({ status: 'succeeded' as const }));
    const { catalog, tool } = trustedCatalog({
      executable: { validatePrepared, execute }
    });
    const controller = new AbortController();
    controller.abort();

    await expect(catalog.execute(executionRequest(tool), controller.signal)).resolves.toEqual({
      status: 'cancelled',
      reason: 'effect_execution_cancelled_before_tool_io'
    });
    expect(validatePrepared).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('deep-freezes canonical durable input and execution context before tool I/O', async () => {
    const execute = vi.fn(async (input, context) => {
      expect(Object.isFrozen(input)).toBe(true);
      expect(Object.isFrozen((input as { nested: object }).nested)).toBe(true);
      expect(Object.isFrozen(
        (input as { nested: { values: readonly string[] } }).nested.values
      )).toBe(true);
      expect(Object.isFrozen(context)).toBe(true);
      expect(Object.isFrozen(context.capabilityIds)).toBe(true);
      expect(Object.isFrozen(context.scope)).toBe(true);
      expect(() => {
        (input as { nested: { values: string[] } }).nested.values[0] = 'mutated';
      }).toThrow();
      expect(() => {
        (context.scope as string[])[0] = 'mutated';
      }).toThrow();
      return { status: 'succeeded' as const };
    });
    const { catalog, tool } = trustedCatalog({
      executable: {
        validatePrepared: (input) => ({ status: 'accepted', input }),
        execute
      }
    });

    await expect(catalog.execute({
      ...executionRequest(tool),
      input: { nested: { values: ['safe'] } }
    }, new AbortController().signal)).resolves.toMatchObject({ status: 'succeeded' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('projects exact model-visible contracts without exposing executable callbacks', async () => {
    const { catalog, tool } = trustedCatalog();
    const request = {
      catalog: {
        catalogId: tool.catalogId,
        revision: tool.revision,
        digest: tool.digest,
        allowedToolNames: [tool.toolName]
      },
      availableTools: [{ tool, capabilityIds: ['workspace.write'] }]
    };

    const descriptors = await catalog.readInferenceToolContracts(
      request,
      new AbortController().signal
    );

    expect(descriptors).toEqual([{
      descriptorVersion: 2,
      tool,
      model: {
        description: 'Write one approved Workspace file.',
        guidance: ['Use the exact Workspace-relative path.']
      },
      inputSchema: {
        type: 'object',
        required: ['path'],
        properties: { path: { type: 'string' } }
      },
      scopeSemantics: 'all_requested_workspace_scopes_must_be_granted',
      lifecycleSemantics: 'bounded_invocation'
    }]);
    expect(Object.isFrozen(descriptors)).toBe(true);
    expect(Object.isFrozen(descriptors[0])).toBe(true);
    expect(Object.isFrozen(descriptors[0]?.tool)).toBe(true);
    expect(Object.isFrozen(descriptors[0]?.model)).toBe(true);
    expect(Object.isFrozen(descriptors[0]?.model.guidance)).toBe(true);
    expect(Object.isFrozen(descriptors[0]?.inputSchema)).toBe(true);
    expect(descriptors[0]).not.toHaveProperty('executable');
    expect(descriptors[0]).not.toHaveProperty('outputSchema');

    await expect(catalog.readInferenceToolContracts({
      ...request,
      availableTools: [{
        ...request.availableTools[0],
        tool: { ...tool, contractDigest: `sha256:${'f'.repeat(64)}` }
      }]
    }, new AbortController().signal)).rejects.toThrow(
      'Inference Tool contract request drifted from the exact admission snapshot.'
    );
  });

  it('resolves only contract-pinned static presentation metadata', () => {
    const { catalog, tool } = trustedCatalog();

    expect(catalog.readToolPresentation(tool)).toEqual({
      kind: 'file_change',
      label: '写入工作区文件',
      resultVisibility: 'protected'
    });
    expect(Object.isFrozen(catalog.readToolPresentation(tool))).toBe(true);
    expect(catalog.readToolPresentation({
      ...tool,
      contractDigest: `sha256:${'f'.repeat(64)}`
    })).toBeNull();
  });

  it('retains the compiled document and callback references after source mutation', async () => {
    const artifacts = artifactBytes();
    const document = contractDocument(artifacts);
    const executable = implementation(artifacts);
    const snapshot = compileTrustedAgentToolCatalog({
      catalogId: 'catalog-runtime',
      revision: 7,
      tools: [{ document, executable }]
    });
    const catalog = new ImmutableAgentToolCatalog(snapshot);
    const tool = catalog.availableTools()[0]?.tool as AgentPinnedToolIdentity;
    (document.permission as { approval: string }).approval = 'required';
    (executable as { execute: AgentToolExecutableImplementationV1['execute'] }).execute =
      async () => ({ status: 'failed', error: { code: 'mutated' } });

    await expect(catalog.admit(request(tool))).resolves.toMatchObject({ status: 'allow' });
    await expect(catalog.execute(
      executionRequest(tool),
      new AbortController().signal
    )).resolves.toMatchObject({ status: 'succeeded' });
  });
});

interface TrustedCatalogOptions {
  readonly document?: Partial<AgentToolContractDocumentV2>;
  readonly executable?: Partial<AgentToolExecutableImplementationV1>;
}

function trustedCatalog(options: TrustedCatalogOptions = {}): {
  readonly catalog: ImmutableAgentToolCatalog;
  readonly tool: AgentPinnedToolIdentity;
  readonly snapshot: TrustedAgentToolCatalogSnapshot;
} {
  const artifacts = options.executable?.artifacts ?? artifactBytes();
  const document = contractDocument(artifacts, options.document);
  const executable = implementation(artifacts, options.executable);
  const snapshot = compileTrustedAgentToolCatalog({
    catalogId: 'catalog-runtime',
    revision: 7,
    tools: [{ document, executable }]
  });
  const catalog = new ImmutableAgentToolCatalog(snapshot);
  const tool = catalog.availableTools()[0]?.tool;
  if (tool === undefined) throw new Error('missing_test_tool');
  return { catalog, tool, snapshot };
}

function contractDocument(
  artifacts: AgentToolExecutableImplementationV1['artifacts'],
  overrides: Partial<AgentToolContractDocumentV2> = {}
): AgentToolContractDocumentV2 {
  return {
    documentVersion: 2,
    toolName: 'workspace.write',
    toolVersion: '3.0.0',
    providerId: 'ariadne.builtin',
    model: {
      description: 'Write one approved Workspace file.',
      guidance: ['Use the exact Workspace-relative path.']
    },
    presentation: {
      kind: 'file_change',
      label: '写入工作区文件',
      resultVisibility: 'protected'
    },
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string' } }
    },
    outputSchema: { type: 'object' },
    capabilityIds: ['workspace.write'],
    requiredWorkspaceAccess: 'write',
    permission: { authority: 'run_grant', approval: 'never' },
    scopeSemantics: 'all_requested_workspace_scopes_must_be_granted',
    resourceSemantics: 'workspace_relative_path',
    lifecycleSemantics: 'bounded_invocation',
    sideEffect: 'write',
    idempotency: 'idempotency_key_required',
    recovery: 'retry_same_idempotency_key',
    timeoutMs: 30_000,
    implementationArtifacts: {
      providerDigest: digest(artifacts.provider),
      normalizerDigest: digest(artifacts.normalizer),
      preparedValidatorDigest: digest(artifacts.preparedValidator),
      executeDigest: digest(artifacts.execute)
    },
    ...overrides
  };
}

function implementation(
  artifacts: AgentToolExecutableImplementationV1['artifacts'],
  overrides: Partial<AgentToolExecutableImplementationV1> = {}
): AgentToolExecutableImplementationV1 {
  return {
    artifacts,
    normalizeAndValidate: (input) => {
      try {
        return { status: 'accepted', input: normalizeInput(input) };
      } catch {
        return { status: 'rejected' };
      }
    },
    validatePrepared: (input) => {
      try {
        return { status: 'accepted', input: validatePreparedInput(input) };
      } catch {
        return { status: 'rejected' };
      }
    },
    execute: async () => ({ status: 'succeeded', result: { written: true } }),
    ...overrides
  };
}

function artifactBytes(): AgentToolExecutableImplementationV1['artifacts'] {
  const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
  return {
    provider: bytes('provider-artifact-v1'),
    normalizer: bytes('normalizer-artifact-v1'),
    preparedValidator: bytes('prepared-validator-artifact-v1'),
    execute: bytes('execute-artifact-v1')
  };
}

function digest(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function normalizeInput(input: AgentToolJsonValue): AgentToolJsonValue {
  if (
    typeof input !== 'object'
    || input === null
    || Array.isArray(input)
    || typeof input.path !== 'string'
  ) throw new Error('invalid_path');
  return { path: input.path.trim() };
}

function validatePreparedInput(input: AgentToolJsonValue): AgentToolJsonValue {
  if (
    typeof input !== 'object'
    || input === null
    || Array.isArray(input)
    || typeof input.path !== 'string'
  ) throw new Error('invalid_path');
  return { path: input.path.trim() };
}

function request(
  tool: AgentPinnedToolIdentity,
  overrides: Partial<AgentToolAdmissionRequest> = {}
): AgentToolAdmissionRequest {
  const value: AgentToolAdmissionRequest = {
    run: queuedRun(tool),
    turn: {} as AgentToolAdmissionRequest['turn'],
    attempt: {} as AgentToolAdmissionRequest['attempt'],
    availableTools: [{ tool, capabilityIds: ['workspace.write'] }],
    invocation: {
      toolCallId: 'tool-call',
      tool,
      input: { path: ' src/result.ts ' },
      capabilityIds: ['workspace.write'],
      scope: ['src']
    }
  };
  return { ...value, ...overrides };
}

function executionRequest(tool: AgentPinnedToolIdentity): {
  runId: string;
  effectId: string;
  toolCallId: string;
  tool: AgentPinnedToolIdentity;
  idempotencyKey: string;
  capabilityIds: string[];
  scope: string[];
  input: AgentToolJsonValue;
} {
  return {
    runId: 'run-tool',
    effectId: 'effect-tool',
    toolCallId: 'tool-call',
    tool,
    idempotencyKey: 'effect-idempotency',
    capabilityIds: ['workspace.write'],
    scope: ['src'],
    input: { path: 'src/result.ts' }
  };
}

function queuedRun(tool: AgentPinnedToolIdentity): AgentRun {
  return {
    runId: 'run-tool',
    version: 1,
    binding: {
      bindingVersion: 3,
      sessionId: 'session-tool',
      objectiveRef: {
        kind: 'conversation_message',
        messageId: 'message-tool',
        messageVersion: 1,
        contentDigest: `sha256:${'c'.repeat(64)}`
      },
      workspace: {
        workspaceId: 'workspace-tool',
        revision: 1,
        grantDigest: `sha256:${'d'.repeat(64)}`,
        access: 'write',
        scopeIds: ['src']
      },
      model: { providerId: 'provider-tool', modelId: 'model-tool', settingsRevision: 1 },
      policy: { policyId: 'policy-tool', revision: 1, permissionMode: 'trusted' },
      capabilities: [{ capabilityId: 'workspace.write', scopeIds: ['src'] }],
      toolCatalog: {
        catalogId: tool.catalogId,
        revision: tool.revision,
        digest: tool.digest,
        allowedToolNames: [tool.toolName]
      },
      budget: {
        grantId: 'grant-tool',
        runId: 'run-tool',
        vector: {
          modelTurns: 3,
          toolCalls: 2,
          readCalls: 0,
          writeCalls: 2,
          shellCalls: 0,
          costMicrousd: 100_000
        },
        deadlineAt: '2031-01-01T00:00:00.000Z',
        source: { kind: 'root' }
      }
    },
    state: { status: 'queued', checkpointVersion: 0, queuedAt: '2030-01-01T00:00:00.000Z' },
    turns: [],
    effects: [],
    createdAt: '2030-01-01T00:00:00.000Z',
    updatedAt: '2030-01-01T00:00:00.000Z'
  };
}

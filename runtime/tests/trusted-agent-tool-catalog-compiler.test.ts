import { createHash } from 'node:crypto';

import type {
  AgentPinnedToolIdentity
} from '@ariadne/agent-core';
import { describe, expect, it } from 'vitest';

import { ImmutableAgentToolCatalog } from '../src/adapters/tool/ImmutableAgentToolCatalog.js';
import {
  compileTrustedAgentToolCatalog,
  type TrustedAgentToolCatalogCompilationInput,
  type TrustedAgentToolCatalogSnapshot,
  type TrustedAgentToolRegistrationV1
} from '../src/adapters/tool/TrustedAgentToolCatalogCompiler.js';
import type {
  AgentToolContractDocumentV1,
  AgentToolExecutableImplementationV1
} from '../src/control/ports/AgentToolExecution.js';

describe('compileTrustedAgentToolCatalog', () => {
  it('derives deterministic contract and catalog pins after code-unit sorting', () => {
    const write = registration({ toolName: 'workspace.write' });
    const read = registration({
      toolName: 'workspace.read',
      capabilityIds: ['workspace.read'],
      requiredWorkspaceAccess: 'read',
      sideEffect: 'read'
    });
    const left = compile([write, read]);
    const right = compile([read, write]);

    expect(left.catalogDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(left.catalogDigest).toBe(right.catalogDigest);
    expect(left.entries.map((entry) => entry.tool.toolName)).toEqual([
      'workspace.read',
      'workspace.write'
    ]);
    expect(left.entries.map((entry) => entry.tool.contractDigest)).toEqual(
      right.entries.map((entry) => entry.tool.contractDigest)
    );
    expect(left.entries.every((entry) => entry.tool.digest === left.catalogDigest)).toBe(true);
  });

  it('changes contractDigest for schema, permission, normalizer, and execute authority', () => {
    const baseline = contractDigest(registration());
    const schema = contractDigest(registration({
      inputSchema: {
        type: 'object',
        required: ['path', 'content'],
        properties: {
          path: { type: 'string' },
          content: { type: 'string' }
        }
      }
    }));
    const permission = contractDigest(registration({
      permission: { authority: 'run_grant', approval: 'required' }
    }));
    const normalizer = contractDigest(registration({
      artifactOverrides: { normalizer: bytes('normalizer-artifact-v2') }
    }));
    const execute = contractDigest(registration({
      artifactOverrides: { execute: bytes('execute-artifact-v2') }
    }));
    const lifecycle = contractDigest(registration({
      lifecycleSemantics: 'resource_create'
    }));

    expect(new Set([baseline, schema, permission, normalizer, execute, lifecycle]).size).toBe(6);
  });

  it('changes catalogDigest when a Tool or capability contract changes', () => {
    const baseline = compile([registration()]).catalogDigest;
    const toolChanged = compile([registration({ toolName: 'workspace.write.v2' })])
      .catalogDigest;
    const capabilityChanged = compile([registration({
      capabilityIds: ['workspace.admin', 'workspace.write']
    })]).catalogDigest;

    expect(toolChanged).not.toBe(baseline);
    expect(capabilityChanged).not.toBe(baseline);
  });

  it('rejects an old durable pin against a newly compiled snapshot', async () => {
    const oldCatalog = new ImmutableAgentToolCatalog(compile([registration()]));
    const newCatalog = new ImmutableAgentToolCatalog(compile([registration({
      inputSchema: { type: 'object', required: ['path'], additionalProperties: false }
    })]));
    const oldTool = onlyTool(oldCatalog);

    await expect(newCatalog.execute({
      runId: 'run-old-pin',
      effectId: 'effect-old-pin',
      toolCallId: 'call-old-pin',
      tool: oldTool,
      idempotencyKey: 'key-old-pin',
      capabilityIds: ['workspace.write'],
      scope: ['src'],
      input: { path: 'src/result.ts' }
    }, new AbortController().signal)).rejects.toThrow('exact immutable Tool identity');
  });

  it('fails closed when implementation artifact evidence is missing or mismatched', () => {
    const valid = registration();
    const mismatchedExecutable: AgentToolExecutableImplementationV1 = {
      ...valid.executable,
      artifacts: {
        ...valid.executable.artifacts,
        execute: bytes('unattested-execute-artifact')
      }
    };
    expect(() => compile([{ document: valid.document, executable: mismatchedExecutable }]))
      .toThrow('executeDigest does not match');

    const emptyExecutable: AgentToolExecutableImplementationV1 = {
      ...valid.executable,
      artifacts: { ...valid.executable.artifacts, provider: new Uint8Array() }
    };
    expect(() => compile([{ document: valid.document, executable: emptyExecutable }]))
      .toThrow('verified artifact bytes');

    const missingArtifacts = {
      normalizeAndValidate: valid.executable.normalizeAndValidate,
      validatePrepared: valid.executable.validatePrepared,
      execute: valid.executable.execute
    } as unknown as AgentToolExecutableImplementationV1;
    expect(() => compile([{ document: valid.document, executable: missingArtifacts }]))
      .toThrow('exact contract fields');
  });

  it('rejects caller-supplied final pins and unbranded snapshots', () => {
    const valid = registration();
    const registrationWithPin = {
      ...valid,
      tool: {
        digest: `sha256:${'a'.repeat(64)}`,
        contractDigest: `sha256:${'b'.repeat(64)}`
      }
    } as unknown as TrustedAgentToolRegistrationV1;
    expect(() => compile([registrationWithPin])).toThrow('exact contract fields');

    const inputWithDigest = {
      catalogId: 'catalog-runtime',
      revision: 7,
      digest: `sha256:${'a'.repeat(64)}`,
      tools: [valid]
    } as unknown as TrustedAgentToolCatalogCompilationInput;
    expect(() => compileTrustedAgentToolCatalog(inputWithDigest))
      .toThrow('exact contract fields');

    const forged = {
      catalogId: 'catalog-runtime',
      revision: 7,
      catalogDigest: `sha256:${'a'.repeat(64)}`,
      entries: []
    } as unknown as TrustedAgentToolCatalogSnapshot;
    expect(() => new ImmutableAgentToolCatalog(forged)).toThrow('compiler-verified');
  });

  it('rejects duplicate names instead of resolving by last registration', () => {
    expect(() => compile([registration(), registration()])).toThrow('duplicate toolName');
  });
});

interface RegistrationOptions extends Partial<AgentToolContractDocumentV1> {
  readonly artifactOverrides?: Partial<AgentToolExecutableImplementationV1['artifacts']>;
}

function registration(options: RegistrationOptions = {}): TrustedAgentToolRegistrationV1 {
  const defaults = artifactBytes();
  const artifacts = { ...defaults, ...options.artifactOverrides };
  const {
    artifactOverrides: _artifactOverrides,
    ...documentOverrides
  } = options;
  const document: AgentToolContractDocumentV1 = {
    documentVersion: 1,
    toolName: 'workspace.write',
    toolVersion: '3.0.0',
    providerId: 'ariadne.builtin',
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
    ...documentOverrides
  };
  return {
    document,
    executable: {
      artifacts,
      normalizeAndValidate: (input) => ({ status: 'accepted', input }),
      validatePrepared: (input) => ({ status: 'accepted', input }),
      execute: async () => ({ status: 'succeeded' })
    }
  };
}

function compile(
  tools: readonly TrustedAgentToolRegistrationV1[]
): TrustedAgentToolCatalogSnapshot {
  return compileTrustedAgentToolCatalog({
    catalogId: 'catalog-runtime',
    revision: 7,
    tools
  });
}

function contractDigest(registrationValue: TrustedAgentToolRegistrationV1): string {
  const digestValue = compile([registrationValue]).entries[0]?.tool.contractDigest;
  if (digestValue === undefined) throw new Error('missing_contract_digest');
  return digestValue;
}

function onlyTool(catalog: ImmutableAgentToolCatalog): AgentPinnedToolIdentity {
  const tool = catalog.availableTools()[0]?.tool;
  if (tool === undefined) throw new Error('missing_tool');
  return tool;
}

function artifactBytes(): AgentToolExecutableImplementationV1['artifacts'] {
  return {
    provider: bytes('provider-artifact-v1'),
    normalizer: bytes('normalizer-artifact-v1'),
    preparedValidator: bytes('prepared-validator-artifact-v1'),
    execute: bytes('execute-artifact-v1')
  };
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function digest(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

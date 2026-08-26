import { describe, expect, it } from 'vitest';
import {
  assertValidAgentAvailableTool,
  assertValidAgentDirective,
  assertValidAgentPinnedToolIdentity,
  assertValidAgentToolAdmissionDecision,
  cloneCanonicalAgentToolInput
} from '../src/index.js';
import {
  testAvailableTool,
  testPinnedToolIdentity
} from './fixtures.js';

describe('pinned Tool admission contract', () => {
  it('owns a sorted data-only clone and normalizes negative zero', () => {
    const source = {
      z: -0,
      a: [{ nested: true }]
    };
    const clone = cloneCanonicalAgentToolInput(source);

    expect(clone).toEqual({ a: [{ nested: true }], z: 0 });
    expect(clone).not.toBe(source);
    expect(Object.keys(clone as object)).toEqual(['a', 'z']);
    expect(Object.is((clone as { readonly z: number }).z, -0)).toBe(false);
    source.a[0]!.nested = false;
    expect(clone).toEqual({ a: [{ nested: true }], z: 0 });
  });

  it('rejects accessors, hidden or symbol fields, prototypes, sparse arrays, cycles, and JSON coercions', () => {
    let getterRead = false;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, 'secret', {
      enumerable: true,
      get() {
        getterRead = true;
        return 'must-not-run';
      }
    });
    expect(() => cloneCanonicalAgentToolInput(accessor)).toThrow(/data field/);
    expect(getterRead).toBe(false);

    const hidden = { visible: true };
    Object.defineProperty(hidden, 'hidden', { value: true, enumerable: false });
    expect(() => cloneCanonicalAgentToolInput(hidden)).toThrow(/data field/);

    const symbol = { visible: true } as Record<PropertyKey, unknown>;
    symbol[Symbol('hidden')] = true;
    expect(() => cloneCanonicalAgentToolInput(symbol)).toThrow(/symbol/);

    expect(() => cloneCanonicalAgentToolInput(new Date())).toThrow(/plain JSON data/);
    expect(() => cloneCanonicalAgentToolInput([, 'sparse'])).toThrow(/dense/);
    const extendedArray = ['value'] as unknown[] & { extra?: string };
    extendedArray.extra = 'hidden';
    expect(() => cloneCanonicalAgentToolInput(extendedArray)).toThrow(/dense/);

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => cloneCanonicalAgentToolInput(cyclic)).toThrow(/cyclic/);
    expect(() => cloneCanonicalAgentToolInput({ omitted: undefined })).toThrow(
      /plain JSON data/
    );
    expect(() => cloneCanonicalAgentToolInput({ invalid: Number.NaN })).toThrow(
      /non-finite/
    );
  });

  it('requires exact canonical pinned identity and available-tool fields', () => {
    const identity = testPinnedToolIdentity('workspace.write');
    expect(() => assertValidAgentPinnedToolIdentity(identity)).not.toThrow();
    expect(() => assertValidAgentAvailableTool(
      testAvailableTool('workspace.write')
    )).not.toThrow();

    expect(() => assertValidAgentPinnedToolIdentity({
      ...identity,
      runtimeHandler: 'must-not-cross-core'
    } as typeof identity)).toThrow(/unsupported field/);
    expect(() => assertValidAgentPinnedToolIdentity({
      ...identity,
      contractDigest: 'not-a-digest'
    })).toThrow(/SHA-256/);
    expect(() => assertValidAgentPinnedToolIdentity({
      ...identity,
      providerId: ' provider-with-whitespace '
    })).toThrow(/canonical/);
    expect(() => assertValidAgentAvailableTool({
      ...testAvailableTool('workspace.write'),
      runtimeSchema: true
    } as ReturnType<typeof testAvailableTool>)).toThrow(/unsupported field/);
  });

  it('requires exact data-only admitted identity, capability, scope, and input fields', () => {
    const valid = {
      status: 'allow' as const,
      tool: testPinnedToolIdentity('workspace.write'),
      capabilityIds: ['workspace.write'],
      scope: ['src/result.ts'],
      normalizedInput: { path: 'src/result.ts' }
    };
    expect(() => assertValidAgentToolAdmissionDecision(valid)).not.toThrow();
    expect(() => assertValidAgentToolAdmissionDecision({
      ...valid,
      adapterHandle: 'must-not-cross-core'
    } as typeof valid)).toThrow(/exact data fields/);
    expect(() => assertValidAgentToolAdmissionDecision({
      ...valid,
      capabilityIds: ['workspace.write', 'workspace.write']
    })).toThrow(/duplicate/);
    const sparseScope = new Array<string>(1);
    expect(() => assertValidAgentToolAdmissionDecision({
      ...valid,
      scope: sparseScope
    })).toThrow(/dense/);
  });

  it('rejects reordered Tool, Directive, and admission-policy collections', () => {
    expect(() => assertValidAgentAvailableTool({
      tool: testPinnedToolIdentity('workspace.write'),
      capabilityIds: ['workspace.write', 'workspace.read']
    })).toThrow(/sorted/);

    expect(() => assertValidAgentDirective({
      kind: 'invoke_tools',
      invocations: [{
        toolCallId: 'call-unsorted-capabilities',
        tool: testPinnedToolIdentity('workspace.write'),
        input: {},
        capabilityIds: ['workspace.write', 'workspace.read'],
        scope: ['workspace']
      }]
    })).toThrow(/sorted/);
    expect(() => assertValidAgentDirective({
      kind: 'invoke_tools',
      invocations: [{
        toolCallId: 'call-unsorted-scope',
        tool: testPinnedToolIdentity('workspace.write'),
        input: {},
        capabilityIds: ['workspace.write'],
        scope: ['workspace', 'scope']
      }]
    })).toThrow(/sorted/);

    const admitted = {
      status: 'allow' as const,
      tool: testPinnedToolIdentity('workspace.write'),
      capabilityIds: ['workspace.write'],
      scope: ['workspace'],
      normalizedInput: {}
    };
    expect(() => assertValidAgentToolAdmissionDecision({
      ...admitted,
      capabilityIds: ['workspace.write', 'workspace.read']
    })).toThrow(/sorted/);
    expect(() => assertValidAgentToolAdmissionDecision({
      ...admitted,
      scope: ['workspace', 'scope']
    })).toThrow(/sorted/);
  });
});

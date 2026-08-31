import { describe, expect, it, vi } from 'vitest';

import {
  compileComponentCatalog,
  compileComponentDefinitionGraph,
  consumes,
  createDeclaredServiceScope,
  defineComponent,
  invokeComponentLifecycleReverse,
  provides,
  publishComponentServices,
  serviceToken
} from '../src/index.js';

const upstream = serviceToken<{ readonly value: string }>('test.upstream');
const downstream = serviceToken<{ readonly source: string }>('test.downstream');

describe('component kernel', () => {
  it('orders a frozen graph from declared component and service dependencies', () => {
    const producer = defineComponent({
      id: 'test.producer', version: '1.0.0', entity: 'agent', required: true,
      provides: [provides(upstream)]
    });
    const consumer = defineComponent({
      id: 'test.consumer', version: '1.0.0', entity: 'agent',
      consumes: [consumes(upstream)], provides: [provides(downstream)]
    });

    const ordered = compileComponentDefinitionGraph('agent', [consumer, producer]);

    expect(ordered.map((item) => item.id)).toEqual(['test.producer', 'test.consumer']);
    expect(Object.isFrozen(ordered)).toBe(true);
    expect(Object.isFrozen(ordered[0])).toBe(true);
  });

  it('fails closed before start on missing, duplicate, and cyclic ownership', () => {
    const missing = defineComponent({
      id: 'test.consumer', version: '1.0', entity: 'agent',
      consumes: [consumes(upstream)]
    });
    expect(() => compileComponentDefinitionGraph('agent', [missing]))
      .toThrow('component_service_dependency_missing:test.upstream');

    const first = defineComponent({
      id: 'test.first', version: '1.0', entity: 'agent', dependsOn: ['test.second']
    });
    const second = defineComponent({
      id: 'test.second', version: '1.0', entity: 'agent', dependsOn: ['test.first']
    });
    expect(() => compileComponentDefinitionGraph('agent', [first, second]))
      .toThrow('component_dependency_cycle');

    const duplicate = defineComponent({
      id: 'test.first', version: '1.0', entity: 'agent'
    });
    expect(() => compileComponentDefinitionGraph('agent', [first, duplicate]))
      .toThrow('component_duplicate:test.first');
  });

  it('exposes only declared typed services and publishes atomically', () => {
    const producer = defineComponent({
      id: 'test.producer', version: '1.0', entity: 'agent',
      provides: [provides(upstream), provides(downstream)]
    });
    const consumer = defineComponent({
      id: 'test.consumer', version: '1.0', entity: 'agent',
      consumes: [consumes(upstream)]
    });
    const services = new Map<string, unknown>();
    expect(() => publishComponentServices(producer, [{
      service: upstream,
      value: { value: 'ready' }
    }], services)).toThrow(
      'component_required_service_not_provided:test.producer:test.downstream'
    );
    expect(services.size).toBe(0);

    publishComponentServices(producer, [
      { service: upstream, value: { value: 'ready' } },
      { service: downstream, value: { source: 'ready' } }
    ], services);
    const scope = createDeclaredServiceScope(consumer, services);
    expect(scope.required(upstream)).toEqual({ value: 'ready' });
    expect(() => scope.required(downstream)).toThrow(
      'component_service_access_not_declared:test.consumer:test.downstream'
    );
  });

  it('produces the same SHA-256 catalog digest regardless of input order', async () => {
    const first = defineComponent({
      id: 'test.first', version: '1.0.0', entity: 'ui', required: true,
      provides: [provides(upstream)]
    });
    const second = defineComponent({
      id: 'test.second', version: '1.0.0', entity: 'ui',
      consumes: [consumes(upstream)]
    });

    const left = await compileComponentCatalog('ui', [first, second]);
    const right = await compileComponentCatalog('ui', [second, first]);

    expect(left.digest).toBe(right.digest);
    expect(left.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(left.entries)).toBe(true);
  });

  it('closes started components in reverse order and keeps collecting failures', async () => {
    const calls: string[] = [];
    const failure = new Error('close failed');
    const failures = await invokeComponentLifecycleReverse([
      { handle: { close: vi.fn(() => { calls.push('first'); }) } },
      { handle: { close: vi.fn(() => { calls.push('second'); throw failure; }) } }
    ], {}, 'close');

    expect(calls).toEqual(['second', 'first']);
    expect(failures).toEqual([failure]);
  });
});

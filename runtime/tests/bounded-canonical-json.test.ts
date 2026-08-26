import { describe, expect, it } from 'vitest';

import { boundedCanonicalJson } from '../src/ingress/BoundedCanonicalJson.js';

describe('boundedCanonicalJson', () => {
  it('sorts nested keys and normalizes negative zero', () => {
    expect(boundedCanonicalJson({ z: { b: -0, a: 1 }, a: true })).toBe(
      '{"a":true,"z":{"a":1,"b":0}}'
    );
  });

  it('rejects lossy, executable, cyclic, and non-plain values', () => {
    expect(() => boundedCanonicalJson({ value: undefined })).toThrow(
      'canonical_json_undefined_value'
    );
    expect(() => boundedCanonicalJson(Object.assign([], { extra: true }))).toThrow(
      'canonical_json_array_property_invalid'
    );
    expect(() => boundedCanonicalJson(new Date())).toThrow(
      'canonical_json_non_plain_object'
    );
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => boundedCanonicalJson(cyclic)).toThrow('canonical_json_cycle');
  });

  it('enforces explicit structural bounds', () => {
    expect(() => boundedCanonicalJson(
      { nested: { value: true } },
      { maxDepth: 1 }
    )).toThrow('canonical_json_depth_limit_exceeded');
    expect(() => boundedCanonicalJson(
      ['a', 'b'],
      { maxNodes: 2 }
    )).toThrow('canonical_json_node_limit_exceeded');
    expect(() => boundedCanonicalJson(
      { value: 'too-long' },
      { maxCharacters: 5 }
    )).toThrow('canonical_json_character_limit_exceeded');
  });
});

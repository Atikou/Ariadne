import { describe, expect, it } from 'vitest';
import {
  assertCanonicalPublicId,
  assertNonNegativeInteger,
  assertPositiveInteger,
  assertTimestamp
} from '../src/index.js';

describe('public-representable Agent domain values', () => {
  it('accepts only canonical trimmed IDs between 1 and 256 characters', () => {
    expect(() => assertCanonicalPublicId('run-1', 'id')).not.toThrow();
    expect(() => assertCanonicalPublicId('x'.repeat(256), 'id')).not.toThrow();
    expect(() => assertCanonicalPublicId(' run-1 ', 'id')).toThrow(/canonical trimmed/);
    expect(() => assertCanonicalPublicId('', 'id')).toThrow(/between 1 and 256/);
    expect(() => assertCanonicalPublicId('x'.repeat(257), 'id')).toThrow(/between 1 and 256/);
  });

  it('requires canonical millisecond ISO timestamps with an explicit offset', () => {
    expect(() => assertTimestamp('2026-07-31T00:00:00.000Z', 'at')).not.toThrow();
    expect(() => assertTimestamp('2026-07-31T08:00:00.000+08:00', 'at')).not.toThrow();
    expect(() => assertTimestamp('Fri, 31 Jul 2026 00:00:00 GMT', 'at'))
      .toThrow(/canonical ISO 8601/);
    expect(() => assertTimestamp('2026-07-31T00:00:00.000', 'at'))
      .toThrow(/canonical ISO 8601/);
    expect(() => assertTimestamp('2026-02-30T00:00:00.000Z', 'at'))
      .toThrow(/canonical ISO 8601/);
    expect(() => assertTimestamp('2026-07-31T00:00:00Z', 'at'))
      .toThrow(/canonical ISO 8601/);
  });

  it('rejects unsafe integer versions, checkpoints, sequences, and revisions', () => {
    expect(() => assertPositiveInteger(Number.MAX_SAFE_INTEGER, 'version')).not.toThrow();
    expect(() => assertNonNegativeInteger(Number.MAX_SAFE_INTEGER, 'sequence')).not.toThrow();
    expect(() => assertPositiveInteger(2 ** 53, 'version')).toThrow(/safe integer/);
    expect(() => assertNonNegativeInteger(2 ** 53, 'sequence')).toThrow(/safe integer/);
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ModelCapabilityRegistry } from '../src/model/capability/ModelCapabilityRegistry.js';
import { unknownQualification } from '../src/model/capability/ModelCapabilityQualification.js';
import { assertStoredModelQualityReport } from '../src/model/capability/StoredModelQuality.js';

const stored = {
  benchmarkId: 'ariadne-text-quality-v1', benchmarkDigest: 'sha256:2c8dfbc37c7503a6e9a8625d2e6382661dea9af2c98d8e0212a6322be5c5cb63',
  passed: 6, total: 6, score: 1, evaluatedAt: '2026-10-01T00:00:00.000Z', validUntil: '2026-10-31T00:00:00.000Z',
  cases: ['arithmetic', 'chinese-constraint', 'extract-record', 'ordered-data', 'data-boundary', 'code-reasoning']
    .map(caseId => ({ caseId, passed: true, outputDigest: `sha256:${'a'.repeat(64)}`, failureCode: null }))
};
describe('retained historical quality evidence', () => {
  it('validates stored integrity without an evaluator or prompts', () => {
    expect(assertStoredModelQualityReport(stored)).toEqual(stored);
    expect(() => assertStoredModelQualityReport({ ...stored, score: 0 })).toThrow();
    expect(() => assertStoredModelQualityReport({ ...stored, cases: [...stored.cases].reverse() })).toThrow();
  });
  it('retains historical evidence across capability refresh and database reopen', () => {
    const root = mkdtempSync(join(tmpdir(), 'ariadne-stored-quality-'));
    let registry: ModelCapabilityRegistry | undefined;
    try {
      const file = join(root, 'capabilities.db');
      const base = unknownQualification({ providerId: 'fixture', modelId: 'model', fingerprint: `sha256:${'b'.repeat(64)}` });
      registry = new ModelCapabilityRegistry(file);
      registry.write({ ...base, quality: assertStoredModelQualityReport(stored) });
      registry.write({ ...base, textResponse: 'qualified' });
      registry.close();
      registry = new ModelCapabilityRegistry(file);
      expect(registry.read(base.providerId, base.modelId, base.fingerprint)).toMatchObject({ textResponse: 'qualified', quality: stored });
    } finally {
      registry?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

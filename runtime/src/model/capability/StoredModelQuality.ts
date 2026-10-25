import { z } from 'zod';
import { modelQualitySummarySchema } from '@ariadne/protocol/public';

/** Read-only validation of reports already stored by released versions.
 * The benchmark executor, prompts and routing have been retired. Keep these
 * integrity checks until support for the containing database format ends.
 */
const releasedDigest = 'sha256:2c8dfbc37c7503a6e9a8625d2e6382661dea9af2c98d8e0212a6322be5c5cb63';
const releasedCases = ['arithmetic', 'chinese-constraint', 'extract-record', 'ordered-data', 'data-boundary', 'code-reasoning'];
const reportSchema = z.object(modelQualitySummarySchema.shape).omit({ state: true }).extend({
  cases: z.array(z.object({
    caseId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u), passed: z.boolean(),
    outputDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    failureCode: z.enum(['binding_unavailable', 'invalid_response', 'answer_mismatch', 'provider_failed']).nullable()
  }).strict()).length(6)
}).strict();
export type StoredModelQualityReport = z.infer<typeof reportSchema>;
export function assertStoredModelQualityReport(input: unknown): StoredModelQualityReport {
  const report = reportSchema.parse(input);
  if (new Set(report.cases.map(entry => entry.caseId)).size !== 6
    || report.cases.some((entry, index) => (report.benchmarkDigest === releasedDigest && entry.caseId !== releasedCases[index])
      || entry.passed !== (entry.failureCode === null))
    || report.passed !== report.cases.filter(entry => entry.passed).length
    || report.score !== report.passed / report.total
    || Date.parse(report.validUntil) !== Date.parse(report.evaluatedAt) + 30 * 24 * 60 * 60_000) {
    throw new Error('model_quality_report_invalid');
  }
  return report;
}

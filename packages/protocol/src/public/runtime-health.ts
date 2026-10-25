import { z } from 'zod';
import { isoDateTimeSchema } from '../common.js';

export const PUBLIC_RUNTIME_HEALTH_DOMAINS = [
  'execution', 'conversation', 'projection', 'productivity', 'schedule',
  'workflow', 'goal', 'memory', 'documents', 'inference', 'journal'
] as const;
export const runtimeDomainHealthSchema = z.object({
  domain: z.enum(PUBLIC_RUNTIME_HEALTH_DOMAINS), source: z.enum(PUBLIC_RUNTIME_HEALTH_DOMAINS),
  availability: z.enum(['healthy', 'degraded', 'unavailable']), observedAt: isoDateTimeSchema,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  code: z.enum(['none', 'worker_failed', 'authority_unavailable', 'task_quarantined', 'external_unavailable']),
  recovery: z.enum(['none', 'reconcile', 'restart', 'repair'])
}).strict().superRefine((value, context) => {
  if (value.availability === 'healthy' ? value.code !== 'none' || value.recovery !== 'none'
    : value.code === 'none' || value.recovery === 'none') {
    context.addIssue({ code: 'custom', message: 'Runtime health state and failure metadata disagree.' });
  }
});
export const runtimeHealthSchema = z.object({
  contractVersion: z.literal('1.0'), observedAt: isoDateTimeSchema,
  /** Absence of a domain does not establish its availability. */
  coverage: z.literal('registered_domains'),
  domains: z.array(runtimeDomainHealthSchema).max(PUBLIC_RUNTIME_HEALTH_DOMAINS.length)
}).strict().superRefine((value, context) => {
  if (new Set(value.domains.map(domain => domain.domain)).size !== value.domains.length) {
    context.addIssue({ code: 'custom', message: 'Runtime health domain is duplicated.' });
  }
});
export type RuntimeDomainHealthSnapshot = z.infer<typeof runtimeDomainHealthSchema>;
export type RuntimeHealth = z.infer<typeof runtimeHealthSchema>;
export type RuntimeHealthDomain = RuntimeDomainHealthSnapshot['domain'];
export type RuntimeHealthAvailability = RuntimeDomainHealthSnapshot['availability'];
export type RuntimeHealthRecovery = RuntimeDomainHealthSnapshot['recovery'];
export type RuntimeHealthCode = RuntimeDomainHealthSnapshot['code'];

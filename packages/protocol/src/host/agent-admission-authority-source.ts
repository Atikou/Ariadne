import { z } from 'zod';

import { nonEmptyIdSchema } from '../common.js';

const positiveRevisionSchema = z.number().int().positive().safe();
const nonNegativeBudgetValueSchema = z.number().int().nonnegative().safe();
const sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const canonicalIsoDateTimeSchema = z.string().datetime({
  offset: true,
  precision: 3
});

const canonicalSortedIdsSchema = z.array(nonEmptyIdSchema).min(1).max(256)
  .superRefine((values, context) => {
    for (let index = 1; index < values.length; index += 1) {
      if (values[index - 1]! >= values[index]!) {
        context.addIssue({
          code: 'custom',
          path: [index],
          message: 'IDs must be strictly code-unit sorted without duplicates.'
        });
      }
    }
  });

const agentAdmissionWorkspaceAuthoritySchema = z.object({
  workspaceId: nonEmptyIdSchema,
  revision: positiveRevisionSchema,
  grantDigest: sha256DigestSchema,
  access: z.enum(['read', 'write']),
  scopeIds: canonicalSortedIdsSchema
}).strict();

const agentAdmissionModelAuthoritySchema = z.object({
  providerId: nonEmptyIdSchema,
  modelId: nonEmptyIdSchema,
  settingsRevision: positiveRevisionSchema
}).strict();

const agentAdmissionModelCandidatesSchema = z.array(
  agentAdmissionModelAuthoritySchema
).min(1).max(32).superRefine((models, context) => {
  const identities = new Set<string>();
  models.forEach((model, index) => {
    const identity = `${model.providerId}\u0000${model.modelId}\u0000${String(model.settingsRevision)}`;
    if (identities.has(identity)) {
      context.addIssue({
        code: 'custom',
        path: [index],
        message: 'Model authority candidates must be unique.'
      });
    }
    identities.add(identity);
  });
});

const agentAdmissionPolicyAuthoritySchema = z.object({
  policyId: nonEmptyIdSchema,
  revision: positiveRevisionSchema,
  permissionMode: z.enum(['ask', 'trusted'])
}).strict();

const agentAdmissionCapabilityAuthoritySchema = z.object({
  capabilityId: nonEmptyIdSchema,
  scopeIds: canonicalSortedIdsSchema
}).strict();

const agentAdmissionCapabilityGrantAuthoritySchema = z.object({
  grantId: nonEmptyIdSchema,
  revision: positiveRevisionSchema,
  capabilities: z.array(agentAdmissionCapabilityAuthoritySchema).min(1).max(256)
    .superRefine((capabilities, context) => {
      for (let index = 1; index < capabilities.length; index += 1) {
        if (capabilities[index - 1]!.capabilityId >= capabilities[index]!.capabilityId) {
          context.addIssue({
            code: 'custom',
            path: [index, 'capabilityId'],
            message: 'Capabilities must be strictly sorted by capabilityId without duplicates.'
          });
        }
      }
    })
}).strict();

const agentAdmissionToolCatalogAuthoritySchema = z.object({
  catalogId: nonEmptyIdSchema,
  revision: positiveRevisionSchema,
  digest: sha256DigestSchema,
  allowedToolNames: canonicalSortedIdsSchema
}).strict();

export const agentAdmissionRootBudgetVectorSchema = z.object({
  modelTurns: nonNegativeBudgetValueSchema,
  toolCalls: nonNegativeBudgetValueSchema,
  readCalls: nonNegativeBudgetValueSchema,
  writeCalls: nonNegativeBudgetValueSchema,
  shellCalls: nonNegativeBudgetValueSchema,
  costMicrousd: nonNegativeBudgetValueSchema
}).strict();

export const agentAdmissionRootBudgetDeadlinePolicySchema = z.object({
  kind: z.literal('absolute'),
  deadlineAt: canonicalIsoDateTimeSchema
}).strict();

const agentAdmissionRootBudgetAuthoritySchema = z.object({
  authorityId: nonEmptyIdSchema,
  revision: positiveRevisionSchema,
  vector: agentAdmissionRootBudgetVectorSchema,
  deadlinePolicy: agentAdmissionRootBudgetDeadlinePolicySchema
}).strict();

/**
 * Complete first-party authority material for one Workspace. It intentionally
 * contains no Session, objective, or Run identity; Runtime binds those exact
 * immutable subjects when the admission query arrives.
 */
export const agentAdmissionAuthoritySourceManifestSchema = z.object({
  manifestVersion: z.literal(1),
  manifestId: nonEmptyIdSchema,
  revision: positiveRevisionSchema,
  workspace: agentAdmissionWorkspaceAuthoritySchema,
  model: agentAdmissionModelAuthoritySchema,
  modelCandidates: agentAdmissionModelCandidatesSchema.optional(),
  policy: agentAdmissionPolicyAuthoritySchema,
  capabilityGrant: agentAdmissionCapabilityGrantAuthoritySchema,
  toolCatalog: agentAdmissionToolCatalogAuthoritySchema,
  rootBudget: agentAdmissionRootBudgetAuthoritySchema
}).strict().superRefine((manifest, context) => {
  if (
    manifest.modelCandidates !== undefined
    && !manifest.modelCandidates.some((candidate) => (
      candidate.providerId === manifest.model.providerId
      && candidate.modelId === manifest.model.modelId
      && candidate.settingsRevision === manifest.model.settingsRevision
    ))
  ) {
    context.addIssue({
      code: 'custom',
      path: ['modelCandidates'],
      message: 'Model authority candidates must include the default model.'
    });
  }
  const workspaceScopes = new Set(manifest.workspace.scopeIds);
  manifest.capabilityGrant.capabilities.forEach((capability, capabilityIndex) => {
    capability.scopeIds.forEach((scopeId, scopeIndex) => {
      if (!workspaceScopes.has(scopeId)) {
        context.addIssue({
          code: 'custom',
          path: ['capabilityGrant', 'capabilities', capabilityIndex, 'scopeIds', scopeIndex],
          message: 'Capability scopes must be contained by the Workspace authority.'
        });
      }
    });
  });
});

const disabledAgentAdmissionAuthoritySourceSchema = z.object({
  sourceVersion: z.literal(1),
  status: z.literal('disabled'),
  reason: z.enum([
    'not_configured',
    'invalid_first_party_configuration'
  ])
}).strict();

const enabledAgentAdmissionAuthoritySourceSchema = z.object({
  sourceVersion: z.literal(1),
  status: z.literal('enabled'),
  manifests: z.array(agentAdmissionAuthoritySourceManifestSchema).min(1).max(32)
}).strict().superRefine((source, context) => {
  const workspaceIds = new Set<string>();
  const manifestIds = new Set<string>();
  source.manifests.forEach((manifest, index) => {
    if (workspaceIds.has(manifest.workspace.workspaceId)) {
      context.addIssue({
        code: 'custom',
        path: ['manifests', index, 'workspace', 'workspaceId'],
        message: 'Only one admission authority manifest is allowed per Workspace.'
      });
    }
    if (manifestIds.has(manifest.manifestId)) {
      context.addIssue({
        code: 'custom',
        path: ['manifests', index, 'manifestId'],
        message: 'Admission authority manifest IDs must be unique.'
      });
    }
    workspaceIds.add(manifest.workspace.workspaceId);
    manifestIds.add(manifest.manifestId);
  });
});

/** Main -> Runtime source of truth. Missing authority is data, never fallback. */
export const agentAdmissionAuthoritySourceSchema = z.discriminatedUnion('status', [
  disabledAgentAdmissionAuthoritySourceSchema,
  enabledAgentAdmissionAuthoritySourceSchema
]);

export type AgentAdmissionRootBudgetVector = z.infer<
  typeof agentAdmissionRootBudgetVectorSchema
>;
export type AgentAdmissionRootBudgetDeadlinePolicy = z.infer<
  typeof agentAdmissionRootBudgetDeadlinePolicySchema
>;
export type AgentAdmissionAuthoritySourceManifest = z.infer<
  typeof agentAdmissionAuthoritySourceManifestSchema
>;
export type AgentAdmissionAuthoritySource = z.infer<
  typeof agentAdmissionAuthoritySourceSchema
>;

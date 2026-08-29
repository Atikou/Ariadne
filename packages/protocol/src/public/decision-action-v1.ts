import {
  PUBLIC_DECISION_ACTION_CONTRACT_VERSION,
  publicDecisionActionV3Schema,
  publicProjectionCanonicalIdSchema,
  publicProjectionCanonicalTimestampSchema,
  publicProjectionDigestSchema,
  type PublicDecisionActionV3,
  type PublicDecisionChoiceV3
} from './projection-v3.js';
import { z } from 'zod';

const PERMISSION_CHOICES = [
  'allow_once',
  'allow_run',
  'deny'
] as const satisfies readonly PublicDecisionChoiceV3[];
const PLAN_CHOICES = [
  'approve',
  'reject'
] as const satisfies readonly PublicDecisionChoiceV3[];
const RECOVERY_CHOICES = [
  'retry',
  'mark_succeeded',
  'mark_failed',
  'cancel_run'
] as const satisfies readonly PublicDecisionChoiceV3[];
const USER_QUESTION_CHOICES = ['answer'] as const satisfies readonly PublicDecisionChoiceV3[];

interface DecisionActionSourceBaseV1 {
  readonly decisionId: string;
  readonly runId: string;
  readonly checkpoint: {
    readonly runId: string;
    readonly version: number;
  };
  readonly requestedAt: string;
}

/**
 * Readonly structural input so the authoritative Agent Core Decision can be
 * validated directly without copying it into a weaker mutable shape.
 */
export type DecisionActionSourceV1 = DecisionActionSourceBaseV1 & (
  | {
      readonly kind: 'permission';
      readonly effectId: string;
      readonly toolCallId: string;
      readonly capabilityIds: readonly string[];
      readonly scope: readonly string[];
    }
  | {
      readonly kind: 'plan';
      readonly planId: string;
      readonly planVersion: number;
      readonly planHash: string;
    }
  | {
      readonly kind: 'recovery';
      readonly effectId: string;
      readonly uncertainty: string;
      readonly allowedActions: readonly (typeof RECOVERY_CHOICES)[number][];
    }
  | {
      readonly kind: 'user_question';
      readonly questionRef: string;
      readonly questionDigest: string;
    }
);

const positiveVersionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const canonicalIdArraySchema = z.array(publicProjectionCanonicalIdSchema)
  .max(256)
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
const checkpointSchema = z.object({
  runId: publicProjectionCanonicalIdSchema,
  version: positiveVersionSchema
}).strict();
const decisionActionSourceBaseShape = {
  decisionId: publicProjectionCanonicalIdSchema,
  runId: publicProjectionCanonicalIdSchema,
  checkpoint: checkpointSchema,
  requestedAt: publicProjectionCanonicalTimestampSchema
};
const recoveryActionSchema = z.enum(RECOVERY_CHOICES);
const decisionActionSourceV1Schema = z.discriminatedUnion('kind', [
  z.object({
    ...decisionActionSourceBaseShape,
    kind: z.literal('permission'),
    effectId: publicProjectionCanonicalIdSchema,
    toolCallId: publicProjectionCanonicalIdSchema,
    capabilityIds: canonicalIdArraySchema.min(1),
    scope: canonicalIdArraySchema
  }).strict(),
  z.object({
    ...decisionActionSourceBaseShape,
    kind: z.literal('plan'),
    planId: publicProjectionCanonicalIdSchema,
    planVersion: positiveVersionSchema,
    planHash: publicProjectionDigestSchema
  }).strict(),
  z.object({
    ...decisionActionSourceBaseShape,
    kind: z.literal('recovery'),
    effectId: publicProjectionCanonicalIdSchema,
    uncertainty: z.string().min(1).max(100_000).refine(
      (value) => value.trim().length > 0,
      'Recovery uncertainty cannot contain only whitespace.'
    ),
    allowedActions: z.array(recoveryActionSchema).min(1).max(RECOVERY_CHOICES.length)
      .superRefine((values, context) => {
        const canonical = RECOVERY_CHOICES.filter((choice) => values.includes(choice));
        if (
          canonical.length !== values.length
          || canonical.some((choice, index) => choice !== values[index])
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Recovery actions must be unique and in canonical contract order.'
          });
        }
      })
  }).strict(),
  z.object({
    ...decisionActionSourceBaseShape,
    kind: z.literal('user_question'),
    questionRef: publicProjectionCanonicalIdSchema,
    questionDigest: publicProjectionDigestSchema
  }).strict()
]).superRefine((decision, context) => {
  if (decision.checkpoint.runId !== decision.runId) {
    context.addIssue({
      code: 'custom',
      path: ['checkpoint', 'runId'],
      message: 'The Decision checkpoint must belong to the same Run.'
    });
  }
});

/**
 * Pure public-contract derivation. Private source fields participate only in
 * the SHA-256 preimage and are never returned in the descriptor.
 */
export async function derivePublicDecisionActionDescriptorV1(
  decision: DecisionActionSourceV1,
  sessionId: string
): Promise<PublicDecisionActionV3> {
  const source = parseDecisionActionSourceV1(decision);
  const choices = choicesForParsedDecision(source);
  const actionToken = await tokenForParsedDecision(source, sessionId, choices);
  return publicDecisionActionV3Schema.parse({
    contractVersion: PUBLIC_DECISION_ACTION_CONTRACT_VERSION,
    actionToken,
    choices
  });
}

export async function publicDecisionActionTokenV1(
  decision: DecisionActionSourceV1,
  sessionId: string
): Promise<string> {
  const source = parseDecisionActionSourceV1(decision);
  const choices = choicesForParsedDecision(source);
  return tokenForParsedDecision(source, sessionId, choices);
}

async function tokenForParsedDecision(
  decision: z.output<typeof decisionActionSourceV1Schema>,
  sessionId: string,
  choices: readonly PublicDecisionChoiceV3[]
): Promise<string> {
  publicProjectionCanonicalIdSchema.parse(sessionId);
  const privateBinding = decision.kind === 'permission'
    ? [
        decision.effectId,
        decision.toolCallId,
        [...decision.capabilityIds],
        [...decision.scope]
      ]
    : decision.kind === 'plan'
      ? [decision.planId, decision.planVersion, decision.planHash]
      : decision.kind === 'recovery'
        ? [decision.effectId, decision.uncertainty, [...choices]]
        : [decision.questionRef, decision.questionDigest];
  const preimage = JSON.stringify([
    'ariadne.public-decision-action',
    1,
    sessionId,
    decision.kind,
    decision.decisionId,
    decision.runId,
    decision.checkpoint.runId,
    decision.checkpoint.version,
    decision.requestedAt,
    privateBinding
  ]);
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(preimage)
  );
  return `decision-action.v1:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

export function publicDecisionChoicesV1(
  decision: DecisionActionSourceV1
): PublicDecisionChoiceV3[] {
  return choicesForParsedDecision(parseDecisionActionSourceV1(decision));
}

function choicesForParsedDecision(
  decision: z.output<typeof decisionActionSourceV1Schema>
): PublicDecisionChoiceV3[] {
  if (decision.kind === 'permission') return [...PERMISSION_CHOICES];
  if (decision.kind === 'plan') return [...PLAN_CHOICES];
  if (decision.kind === 'recovery') {
    return RECOVERY_CHOICES.filter((choice) => decision.allowedActions.includes(choice));
  }
  return [...USER_QUESTION_CHOICES];
}

function parseDecisionActionSourceV1(
  decision: DecisionActionSourceV1
): z.output<typeof decisionActionSourceV1Schema> {
  return decisionActionSourceV1Schema.parse(decision);
}

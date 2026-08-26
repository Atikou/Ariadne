import { AgentRunInvariantError } from './errors.js';
import type { AgentBudgetVector } from './run-binding.js';
import {
  assertCanonicalPublicId,
  assertNonNegativeInteger,
  assertPositiveInteger,
  assertSha256Digest,
  assertTimestamp
} from './values.js';

export type AgentControlJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly AgentControlJsonValue[]
  | { readonly [key: string]: AgentControlJsonValue };

export interface AgentPlanReference {
  readonly planId: string;
  readonly version: number;
  readonly contentHash: string;
}

export interface AgentPlanVersionCommit {
  readonly ref: AgentPlanReference;
  readonly runId: string;
  readonly payload: AgentControlJsonValue;
  readonly createdAt: string;
}

export interface AgentPlanApprovalCommit {
  readonly approvalId: string;
  readonly decisionId: string;
  readonly runId: string;
  readonly checkpointVersion: number;
  readonly plan: AgentPlanReference;
  readonly approvedAt: string;
}

export type AgentBudgetGrantCommit = {
  readonly grantId: string;
  readonly runId: string;
  readonly vector: AgentBudgetVector;
  readonly deadlineAt: string;
  readonly createdAt: string;
  readonly source:
    | { readonly kind: 'root' }
    | {
        readonly kind: 'parent_allocation';
        readonly parentRunId: string;
        readonly parentGrantId: string;
        readonly delegationId: string;
      };
};

interface AgentBudgetLedgerEntryBase {
  readonly entryId: string;
  readonly runId: string;
  readonly grantId: string;
  readonly vector: AgentBudgetVector;
  readonly occurredAt: string;
}

export type AgentBudgetLedgerEntryCommit =
  | (AgentBudgetLedgerEntryBase & {
      readonly kind: 'root_grant';
    })
  | (AgentBudgetLedgerEntryBase & {
      readonly kind: 'parent_allocation';
      readonly delegationId: string;
      readonly childRunId: string;
      readonly childGrantId: string;
    })
  | (AgentBudgetLedgerEntryBase & {
      readonly kind: 'reservation';
      readonly reservationId: string;
    })
  | (AgentBudgetLedgerEntryBase & {
      readonly kind: 'settlement';
      readonly reservationId: string;
    })
  | (AgentBudgetLedgerEntryBase & {
      readonly kind: 'release';
      readonly reservationId: string;
    })
  | (AgentBudgetLedgerEntryBase & {
      readonly kind: 'child_release';
      readonly delegationId: string;
      readonly childRunId: string;
      readonly childGrantId: string;
    });

export interface AgentDelegationCommit {
  readonly delegationId: string;
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly parentGrantId: string;
  readonly childGrantId: string;
  readonly objectiveDigest: string;
  readonly objective: AgentControlJsonValue;
  readonly required: boolean;
  readonly createdAt: string;
}

export interface AgentChildTerminalCommit {
  readonly delegationId: string;
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly childRunVersion: number;
  readonly childStatus: 'completed' | 'failed' | 'cancelled';
  readonly observedAt: string;
}

export interface AgentControlCommitFacts {
  readonly planVersions: readonly AgentPlanVersionCommit[];
  readonly planApprovals: readonly AgentPlanApprovalCommit[];
  readonly budgetGrants: readonly AgentBudgetGrantCommit[];
  readonly budgetEntries: readonly AgentBudgetLedgerEntryCommit[];
  readonly delegations: readonly AgentDelegationCommit[];
  readonly childTerminals: readonly AgentChildTerminalCommit[];
}

export const EMPTY_AGENT_CONTROL_COMMIT_FACTS: AgentControlCommitFacts = {
  planVersions: [],
  planApprovals: [],
  budgetGrants: [],
  budgetEntries: [],
  delegations: [],
  childTerminals: []
};

export interface AgentBudgetSnapshot {
  readonly grant: AgentBudgetGrantCommit;
  readonly available: AgentBudgetVector;
  readonly reserved: AgentBudgetVector;
  readonly spent: AgentBudgetVector;
  readonly allocated: AgentBudgetVector;
  readonly openReservations: readonly {
    readonly reservationId: string;
    readonly vector: AgentBudgetVector;
  }[];
}

export interface AgentDelegationRecord
extends Omit<AgentDelegationCommit, 'objective'> {
  readonly objective: AgentControlJsonValue;
  readonly terminal: AgentChildTerminalCommit | null;
}

export function zeroAgentBudgetVector(): AgentBudgetVector {
  return {
    modelTurns: 0,
    toolCalls: 0,
    readCalls: 0,
    writeCalls: 0,
    shellCalls: 0,
    costMicrousd: 0
  };
}

export function addAgentBudgetVectors(
  left: AgentBudgetVector,
  right: AgentBudgetVector,
  field = 'budget vector'
): AgentBudgetVector {
  assertAgentBudgetVector(left, `${field}.left`);
  assertAgentBudgetVector(right, `${field}.right`);
  return mapBudgetVector((key) => safeAdd(left[key], right[key], `${field}.${key}`));
}

export function subtractAgentBudgetVectors(
  left: AgentBudgetVector,
  right: AgentBudgetVector,
  field = 'budget vector'
): AgentBudgetVector {
  assertAgentBudgetVector(left, `${field}.left`);
  assertAgentBudgetVector(right, `${field}.right`);
  return mapBudgetVector((key) => {
    const value = left[key] - right[key];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new AgentRunInvariantError(`${field}.${key} cannot be overdrawn.`);
    }
    return value;
  });
}

export function agentBudgetVectorFits(
  requested: AgentBudgetVector,
  available: AgentBudgetVector
): boolean {
  assertAgentBudgetVector(requested, 'requested budget vector');
  assertAgentBudgetVector(available, 'available budget vector');
  return BUDGET_KEYS.every((key) => requested[key] <= available[key]);
}

export function isZeroAgentBudgetVector(vector: AgentBudgetVector): boolean {
  assertAgentBudgetVector(vector, 'budget vector');
  return BUDGET_KEYS.every((key) => vector[key] === 0);
}

export function assertAgentBudgetVector(
  vector: AgentBudgetVector,
  field: string
): void {
  assertPlainObjectExact(
    vector,
    BUDGET_KEYS,
    field
  );
  for (const key of BUDGET_KEYS) {
    assertNonNegativeInteger(vector[key], `${field}.${key}`);
  }
}

export function assertAgentPlanReference(
  reference: AgentPlanReference,
  field: string
): void {
  assertPlainObjectExact(reference, ['planId', 'version', 'contentHash'], field);
  assertCanonicalPublicId(reference.planId, `${field}.planId`);
  assertPositiveInteger(reference.version, `${field}.version`);
  assertSha256Digest(reference.contentHash, `${field}.contentHash`);
}

export function assertAgentControlCommitFacts(facts: AgentControlCommitFacts): void {
  assertPlainObjectExact(
    facts,
    [
      'planVersions',
      'planApprovals',
      'budgetGrants',
      'budgetEntries',
      'delegations',
      'childTerminals'
    ],
    'commit.facts'
  );
  assertDenseArray(facts.planVersions, 'commit.facts.planVersions');
  assertDenseArray(facts.planApprovals, 'commit.facts.planApprovals');
  assertDenseArray(facts.budgetGrants, 'commit.facts.budgetGrants');
  assertDenseArray(facts.budgetEntries, 'commit.facts.budgetEntries');
  assertDenseArray(facts.delegations, 'commit.facts.delegations');
  assertDenseArray(facts.childTerminals, 'commit.facts.childTerminals');

  facts.planVersions.forEach(assertPlanVersionCommit);
  facts.planApprovals.forEach(assertPlanApprovalCommit);
  facts.budgetGrants.forEach(assertBudgetGrantCommit);
  facts.budgetEntries.forEach(assertBudgetLedgerEntry);
  facts.delegations.forEach(assertDelegationCommit);
  facts.childTerminals.forEach(assertChildTerminalCommit);

  assertStrictSortedUnique(
    facts.planVersions,
    (item) => `${item.ref.planId}\u0000${String(item.ref.version).padStart(16, '0')}`,
    'commit.facts.planVersions'
  );
  assertStrictSortedUnique(
    facts.planApprovals,
    (item) => item.approvalId,
    'commit.facts.planApprovals'
  );
  assertStrictSortedUnique(
    facts.budgetGrants,
    (item) => item.grantId,
    'commit.facts.budgetGrants'
  );
  assertStrictSortedUnique(
    facts.budgetEntries,
    (item) => item.entryId,
    'commit.facts.budgetEntries'
  );
  assertStrictSortedUnique(
    facts.delegations,
    (item) => item.delegationId,
    'commit.facts.delegations'
  );
  assertStrictSortedUnique(
    facts.childTerminals,
    (item) => item.delegationId,
    'commit.facts.childTerminals'
  );
}

export function countAgentControlCommitFacts(facts: AgentControlCommitFacts): number {
  return facts.planVersions.length
    + facts.planApprovals.length
    + facts.budgetGrants.length
    + facts.budgetEntries.length
    + facts.delegations.length
    + facts.childTerminals.length;
}

export function cloneAgentControlJsonValue<T extends AgentControlJsonValue>(value: T): T {
  assertAgentControlJsonValue(value, 'protected payload');
  return JSON.parse(JSON.stringify(value)) as T;
}

export function assertAgentControlJsonValue(value: unknown, field: string): void {
  assertJsonValue(value, field, new Set<object>());
}

const BUDGET_KEYS = [
  'modelTurns',
  'toolCalls',
  'readCalls',
  'writeCalls',
  'shellCalls',
  'costMicrousd'
] as const;

function assertPlanVersionCommit(value: AgentPlanVersionCommit): void {
  assertPlainObjectExact(value, ['ref', 'runId', 'payload', 'createdAt'], 'planVersion');
  assertAgentPlanReference(value.ref, 'planVersion.ref');
  assertCanonicalPublicId(value.runId, 'planVersion.runId');
  assertAgentControlJsonValue(value.payload, 'planVersion.payload');
  assertTimestamp(value.createdAt, 'planVersion.createdAt');
}

function assertPlanApprovalCommit(value: AgentPlanApprovalCommit): void {
  assertPlainObjectExact(
    value,
    ['approvalId', 'decisionId', 'runId', 'checkpointVersion', 'plan', 'approvedAt'],
    'planApproval'
  );
  assertCanonicalPublicId(value.approvalId, 'planApproval.approvalId');
  assertCanonicalPublicId(value.decisionId, 'planApproval.decisionId');
  assertCanonicalPublicId(value.runId, 'planApproval.runId');
  assertPositiveInteger(value.checkpointVersion, 'planApproval.checkpointVersion');
  assertAgentPlanReference(value.plan, 'planApproval.plan');
  assertTimestamp(value.approvedAt, 'planApproval.approvedAt');
}

function assertBudgetGrantCommit(value: AgentBudgetGrantCommit): void {
  assertPlainObjectExact(
    value,
    ['grantId', 'runId', 'vector', 'deadlineAt', 'createdAt', 'source'],
    'budgetGrant'
  );
  assertCanonicalPublicId(value.grantId, 'budgetGrant.grantId');
  assertCanonicalPublicId(value.runId, 'budgetGrant.runId');
  assertAgentBudgetVector(value.vector, 'budgetGrant.vector');
  assertTimestamp(value.deadlineAt, 'budgetGrant.deadlineAt');
  assertTimestamp(value.createdAt, 'budgetGrant.createdAt');
  if (value.source.kind === 'root') {
    assertPlainObjectExact(value.source, ['kind'], 'budgetGrant.source');
    return;
  }
  assertPlainObjectExact(
    value.source,
    ['kind', 'parentRunId', 'parentGrantId', 'delegationId'],
    'budgetGrant.source'
  );
  assertCanonicalPublicId(value.source.parentRunId, 'budgetGrant.source.parentRunId');
  assertCanonicalPublicId(value.source.parentGrantId, 'budgetGrant.source.parentGrantId');
  assertCanonicalPublicId(value.source.delegationId, 'budgetGrant.source.delegationId');
}

function assertBudgetLedgerEntry(value: AgentBudgetLedgerEntryCommit): void {
  const extra = value.kind === 'root_grant'
    ? []
    : value.kind === 'reservation'
      || value.kind === 'settlement'
      || value.kind === 'release'
      ? ['reservationId']
      : ['delegationId', 'childRunId', 'childGrantId'];
  assertPlainObjectExact(
    value,
    ['entryId', 'runId', 'grantId', 'kind', 'vector', 'occurredAt', ...extra],
    'budgetEntry'
  );
  assertCanonicalPublicId(value.entryId, 'budgetEntry.entryId');
  assertCanonicalPublicId(value.runId, 'budgetEntry.runId');
  assertCanonicalPublicId(value.grantId, 'budgetEntry.grantId');
  assertAgentBudgetVector(value.vector, 'budgetEntry.vector');
  assertTimestamp(value.occurredAt, 'budgetEntry.occurredAt');
  if ('reservationId' in value) {
    assertCanonicalPublicId(value.reservationId, 'budgetEntry.reservationId');
  }
  if ('delegationId' in value) {
    assertCanonicalPublicId(value.delegationId, 'budgetEntry.delegationId');
    assertCanonicalPublicId(value.childRunId, 'budgetEntry.childRunId');
    assertCanonicalPublicId(value.childGrantId, 'budgetEntry.childGrantId');
  }
}

function assertDelegationCommit(value: AgentDelegationCommit): void {
  assertPlainObjectExact(
    value,
    [
      'delegationId',
      'parentRunId',
      'childRunId',
      'parentGrantId',
      'childGrantId',
      'objectiveDigest',
      'objective',
      'required',
      'createdAt'
    ],
    'delegation'
  );
  assertCanonicalPublicId(value.delegationId, 'delegation.delegationId');
  assertCanonicalPublicId(value.parentRunId, 'delegation.parentRunId');
  assertCanonicalPublicId(value.childRunId, 'delegation.childRunId');
  assertCanonicalPublicId(value.parentGrantId, 'delegation.parentGrantId');
  assertCanonicalPublicId(value.childGrantId, 'delegation.childGrantId');
  assertSha256Digest(value.objectiveDigest, 'delegation.objectiveDigest');
  assertAgentControlJsonValue(value.objective, 'delegation.objective');
  if (typeof value.required !== 'boolean') {
    throw new AgentRunInvariantError('delegation.required must be boolean.');
  }
  assertTimestamp(value.createdAt, 'delegation.createdAt');
}

function assertChildTerminalCommit(value: AgentChildTerminalCommit): void {
  assertPlainObjectExact(
    value,
    [
      'delegationId',
      'parentRunId',
      'childRunId',
      'childRunVersion',
      'childStatus',
      'observedAt'
    ],
    'childTerminal'
  );
  assertCanonicalPublicId(value.delegationId, 'childTerminal.delegationId');
  assertCanonicalPublicId(value.parentRunId, 'childTerminal.parentRunId');
  assertCanonicalPublicId(value.childRunId, 'childTerminal.childRunId');
  assertPositiveInteger(value.childRunVersion, 'childTerminal.childRunVersion');
  if (!['completed', 'failed', 'cancelled'].includes(value.childStatus)) {
    throw new AgentRunInvariantError('childTerminal.childStatus must be terminal.');
  }
  assertTimestamp(value.observedAt, 'childTerminal.observedAt');
}

function mapBudgetVector(
  map: (key: typeof BUDGET_KEYS[number]) => number
): AgentBudgetVector {
  return {
    modelTurns: map('modelTurns'),
    toolCalls: map('toolCalls'),
    readCalls: map('readCalls'),
    writeCalls: map('writeCalls'),
    shellCalls: map('shellCalls'),
    costMicrousd: map('costMicrousd')
  };
}

function safeAdd(left: number, right: number, field: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new AgentRunInvariantError(`${field} exceeds the safe integer range.`);
  }
  return result;
}

function assertDenseArray(value: readonly unknown[], field: string): void {
  if (!Array.isArray(value)) {
    throw new AgentRunInvariantError(`${field} must be an array.`);
  }
  const keys = Reflect.ownKeys(value);
  const expected = new Set<string>(['length']);
  for (let index = 0; index < value.length; index += 1) expected.add(String(index));
  if (
    keys.length !== expected.size
    || keys.some((key) => typeof key !== 'string' || !expected.has(key))
  ) {
    throw new AgentRunInvariantError(`${field} must be a dense data-only array.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new AgentRunInvariantError(`${field} must be a dense data-only array.`);
    }
  }
}

function assertStrictSortedUnique<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  field: string
): void {
  let previous: string | undefined;
  for (const value of values) {
    const key = keyOf(value);
    if (previous !== undefined && previous >= key) {
      throw new AgentRunInvariantError(
        `${field} must be strictly code-unit sorted without duplicates.`
      );
    }
    previous = key;
  }
}

function assertPlainObjectExact(
  value: object,
  keys: readonly string[],
  field: string
): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AgentRunInvariantError(`${field} must be a plain data object.`);
  }
  const actual = Reflect.ownKeys(value);
  const expected = new Set(keys);
  if (
    actual.length !== expected.size
    || actual.some((key) => typeof key !== 'string' || !expected.has(key))
  ) {
    throw new AgentRunInvariantError(`${field} contains unsupported fields.`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new AgentRunInvariantError(`${field}.${key} must be a data property.`);
    }
  }
}

function assertJsonValue(
  value: unknown,
  field: string,
  ancestors: Set<object>
): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new AgentRunInvariantError(`${field} contains a non-finite number.`);
  }
  if (typeof value !== 'object' || value === undefined || ancestors.has(value)) {
    throw new AgentRunInvariantError(`${field} must be acyclic JSON data.`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      assertDenseArray(value, field);
      value.forEach((item, index) => assertJsonValue(item, `${field}[${String(index)}]`, ancestors));
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new AgentRunInvariantError(`${field} must contain plain data objects.`);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        throw new AgentRunInvariantError(`${field} must not contain symbol keys.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new AgentRunInvariantError(`${field}.${key} must be a data property.`);
      }
      assertJsonValue(descriptor.value, `${field}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

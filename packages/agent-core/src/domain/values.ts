import { AgentRunInvariantError } from './errors.js';

export type AgentRunId = string;
export type AgentCommandId = string;
export type AgentDecisionId = string;
export type AgentEffectId = string;
export type AgentPlanId = string;
export type AgentTurnId = string;
export type AgentInferenceAttemptId = string;

export interface RunCheckpoint {
  readonly runId: AgentRunId;
  readonly version: number;
}

export function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AgentRunInvariantError(`${field} must be a non-empty string.`);
  }
}

/** Matches the public contract after parsing; Core never normalizes identity. */
export function assertCanonicalPublicId(value: string, field: string): void {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 256
    || value !== value.trim()
  ) {
    throw new AgentRunInvariantError(
      `${field} must be a canonical trimmed public ID between 1 and 256 characters.`
    );
  }
}

export function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AgentRunInvariantError(`${field} must be a positive safe integer.`);
  }
}

export function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AgentRunInvariantError(`${field} must be a non-negative safe integer.`);
  }
}

export function assertTimestamp(value: string, field: string): void {
  if (!isCanonicalIsoTimestamp(value)) {
    throw new AgentRunInvariantError(
      `${field} must be a canonical ISO 8601 timestamp with milliseconds and an offset.`
    );
  }
}

export function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number(match[7]);
  const offsetHour = match[8] === 'Z' ? 0 : Number(match[10]);
  const offsetMinute = match[8] === 'Z' ? 0 : Number(match[11]);
  if (
    month < 1
    || month > 12
    || day < 1
    || day > daysInMonth(year, month)
    || hour > 23
    || minute > 59
    || second > 59
    || millisecond > 999
    || offsetHour > 23
    || offsetMinute > 59
  ) {
    return false;
  }
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, millisecond);
  const offsetSign = match[9] === '-' ? -1 : 1;
  const offset = match[8] === 'Z'
    ? 0
    : offsetSign * ((offsetHour * 60) + offsetMinute) * 60_000;
  return Date.parse(value) === local.getTime() - offset;
}

export function assertBoundedNonEmpty(
  value: string,
  field: string,
  maximumLength: number
): void {
  assertNonEmpty(value, field);
  if (value.length > maximumLength) {
    throw new AgentRunInvariantError(
      `${field} must not exceed ${String(maximumLength)} characters.`
    );
  }
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function assertSafeNonNegativeInteger(
  value: number,
  field: string,
  maximum: number
): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new AgentRunInvariantError(
      `${field} must be a safe integer between 0 and ${String(maximum)}.`
    );
  }
}

export function assertSha256Digest(value: string, field: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new AgentRunInvariantError(
      `${field} must be a lowercase SHA-256 digest.`
    );
  }
}

export function assertUniqueNonEmpty(values: readonly string[], field: string): void {
  const unique = new Set<string>();
  for (const value of values) {
    assertNonEmpty(value, field);
    if (unique.has(value)) {
      throw new AgentRunInvariantError(`${field} must not contain duplicate values.`);
    }
    unique.add(value);
  }
}

export function assertUniqueCanonicalPublicIds(
  values: readonly string[],
  field: string
): void {
  const unique = new Set<string>();
  for (const value of values) {
    assertCanonicalPublicId(value, field);
    if (unique.has(value)) {
      throw new AgentRunInvariantError(`${field} must not contain duplicate values.`);
    }
    unique.add(value);
  }
}

/** Stable Unicode code-unit order; locale-dependent collation is forbidden. */
export function assertCanonicalSortedPublicIds(
  values: unknown,
  field: string
): asserts values is readonly string[] {
  if (!Array.isArray(values)) {
    throw new AgentRunInvariantError(`${field} must be an array.`);
  }
  const ownKeys = Reflect.ownKeys(values);
  const expected = new Set<string>(['length']);
  for (let index = 0; index < values.length; index += 1) expected.add(String(index));
  if (
    ownKeys.length !== expected.size
    || ownKeys.some((key) => typeof key === 'symbol' || !expected.has(key))
  ) {
    throw new AgentRunInvariantError(`${field} must be a dense data-only array.`);
  }
  let previous: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(values, String(index));
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !('value' in descriptor)
    ) {
      throw new AgentRunInvariantError(`${field} must be a dense data-only array.`);
    }
    const value = descriptor.value as string;
    assertCanonicalPublicId(value, field);
    if (previous !== undefined && previous >= value) {
      throw new AgentRunInvariantError(
        `${field} must be strictly code-unit sorted without duplicates.`
      );
    }
    previous = value;
  }
}

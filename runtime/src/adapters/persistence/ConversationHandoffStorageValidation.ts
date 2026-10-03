import { ConversationAuthorityError } from '../../conversation/ConversationAuthority.js';
import { ConversationRunHandoffError } from '../../conversation/ConversationRunHandoffSaga.js';
import { type ConversationPersistenceClock } from './ConversationHandoffStorageTypes.js';

export function canonicalNow(clock: ConversationPersistenceClock): string {
  const value = clock.now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('conversation_clock_invalid');
  }
  return value.toISOString();
}

export function versionConflict(
  sagaId: string,
  expected: number | null,
  actual: number | null
): ConversationRunHandoffError {
  return new ConversationRunHandoffError(
    'HANDOFF_VERSION_CONFLICT',
    `Conversation saga "${sagaId}" CAS failed; expected ${String(expected)}, found ${String(actual)}.`
  );
}

export function assertCanonicalId(value: string, field: string): void {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 256
    || value.trim() !== value
  ) {
    throw storageInvariant(`${field}:invalid`);
  }
}

export function assertDigest(value: string, field: string): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw storageInvariant(`${field}:invalid`);
  }
}

export function assertCanonicalUtcTimestamp(value: string, field: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw storageInvariant(`${field}:invalid`);
  }
}

export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (!isPlainObject(value)) return 'invalid';
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalize(value[key])}`
  )).join(',')}}`;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isConstraintError(error: unknown): boolean {
  return error instanceof Error
    && (error.message.includes('constraint failed') || error.message.includes('UNIQUE constraint'));
}

export function authorityCommandConflict(cause: unknown): ConversationAuthorityError {
  return new ConversationAuthorityError(
    'CONVERSATION_COMMAND_CONFLICT',
    'Conversation command, event, message, or Saga identity is already bound.',
    { cause }
  );
}

export function authorityStorageCorruption(
  message: string,
  cause?: unknown
): ConversationAuthorityError {
  return new ConversationAuthorityError(
    'CONVERSATION_STORAGE_CORRUPTION',
    `Conversation storage corruption: ${message}.`,
    cause === undefined ? undefined : { cause }
  );
}

export function storageInvariant(message: string, cause?: unknown): Error {
  return new Error(`conversation_storage_corruption:${message}`, { cause });
}

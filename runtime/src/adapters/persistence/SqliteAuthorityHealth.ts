export type SqliteAuthoritySource = 'execution' | 'conversation' | 'projection' | 'productivity' | 'memory' | 'journal' | 'inference';
export type SqliteAuthorityFaultKind = 'integrity' | 'unavailable';
export interface AuthorityFault { readonly source: SqliteAuthoritySource; readonly kind: SqliteAuthorityFaultKind }

// Only owning persisted-data decoders mark errors. Message text, arbitrary
// callback errors, CAS conflicts and malformed command inputs are not evidence.
const authorityFaults = new WeakMap<Error, AuthorityFault>();
export function readOwnedAuthorityFault(error: unknown): AuthorityFault | null {
  if (error instanceof SqliteAuthorityUnavailableError) return Object.freeze({ source: error.source, kind: error.faultKind });
  return error instanceof Error ? authorityFaults.get(error) ?? null : null;
}
/** Called only by the concrete opening owner of the failing connection. */
export function attributeSqliteOpeningFault(source: SqliteAuthoritySource, error: unknown): void {
  const kind = classifySqliteAuthorityFault(source, error);
  if (kind !== null && error instanceof Error && !authorityFaults.has(error))
    authorityFaults.set(error, Object.freeze({ source, kind }));
}
export function markAuthorityIntegrityError<T extends Error>(source: SqliteAuthoritySource, error: T): T {
  authorityFaults.set(error, Object.freeze({ source, kind: 'integrity' }));
  return error;
}
export function markAuthorityUnavailableError<T extends Error>(source: SqliteAuthoritySource, error: T): T {
  authorityFaults.set(error, Object.freeze({ source, kind: 'unavailable' }));
  return error;
}

export function readPersistedAuthorityJson<T = unknown>(
  source: SqliteAuthoritySource, text: string, decode: (value: unknown) => T = value => value as T
): T {
  let value: unknown;
  try { value = JSON.parse(text) as unknown; }
  catch (cause) {
    throw markAuthorityIntegrityError(source, new Error(`${source}_persisted_record_invalid`, { cause }));
  }
  try { return decode(value); }
  catch (error) {
    if (error instanceof Error) throw markAuthorityIntegrityError(source, error);
    throw markAuthorityIntegrityError(source, new Error(`${source}_persisted_record_invalid`, { cause: error }));
  }
}

export function classifySqliteAuthorityFault(source: SqliteAuthoritySource, error: unknown): SqliteAuthorityFaultKind | null {
  if (!(error instanceof Error)) return null;
  const marked = authorityFaults.get(error);
  if (marked !== undefined) return marked.source === source ? marked.kind : null;
  const sqlite = error as Error & { code?: unknown; errcode?: unknown };
  if (sqlite.code !== 'ERR_SQLITE_ERROR' || !Number.isSafeInteger(sqlite.errcode)) return null;
  const primary = (sqlite.errcode as number) & 255;
  if (primary === 11 || primary === 26) return 'integrity'; // CORRUPT, NOTADB
  if ([8, 10, 13, 14].includes(primary)) return 'unavailable'; // READONLY, IOERR, FULL, CANTOPEN
  return null; // BUSY/LOCKED, constraints and SQL/programming errors keep their original semantics.
}

export class SqliteAuthorityUnavailableError extends Error {
  public constructor(public readonly source: SqliteAuthoritySource, public readonly faultKind: SqliteAuthorityFaultKind,
    cause: unknown) { super(`${source}_authority_${faultKind}`, { cause }); this.name = 'SqliteAuthorityUnavailableError'; }
}

/** A resource-owner latch; reopening requires the existing schema/integrity
 * checks. There is deliberately no reset that could resend uncertain writes. */
export class SqliteAuthorityHealth {
  private failure: SqliteAuthorityUnavailableError | null = null;
  public constructor(private readonly source: SqliteAuthoritySource) {}
  public observe(error: unknown): void {
    const kind = classifySqliteAuthorityFault(this.source, error);
    if (kind !== null) {
      if (error instanceof Error && !authorityFaults.has(error)) authorityFaults.set(error, Object.freeze({ source: this.source, kind }));
      if (this.failure === null) this.failure = new SqliteAuthorityUnavailableError(this.source, kind, error);
    }
  }
  public observeFailedRollback(error: unknown): void {
    if (this.failure === null) this.failure = new SqliteAuthorityUnavailableError(this.source, 'unavailable', error);
  }
  public assertHealthy(): void { if (this.failure !== null) throw this.failure; }
}

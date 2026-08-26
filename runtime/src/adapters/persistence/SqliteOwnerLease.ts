import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface SqliteOwnerLease {
  readonly databasePath: string;
  readonly leasePath: string;
  close(): void;
}

interface ClosableSqliteResource {
  close(): void;
}

// If a business connection reports a failed close, its state is uncertain.
// Retain both resources for the remainder of the process so GC cannot release
// the fence and allow another owner beside a possibly live connection.
const uncertainOwnedDatabases = new Set<{
  readonly database: ClosableSqliteResource;
  readonly ownerLease: SqliteOwnerLease;
}>();

/**
 * Resolves the process-owner lock beside, but never inside, the business DB.
 * The lock is a real SQLite database so ownership is released by the OS if the
 * process dies; the file's existence is deliberately not an ownership signal.
 */
export function resolveSqliteOwnerLeasePath(databasePath: string): string {
  const resolved = assertAbsoluteDatabasePath(databasePath);
  return `${resolved}.owner-lock`;
}

/**
 * Acquires the sole-writer lease for one business database.
 *
 * The dedicated lock database stays in rollback-journal mode and holds one
 * `BEGIN EXCLUSIVE` transaction for the complete owner lifetime. A competing
 * process therefore fails immediately at SQLite's lock boundary, while a
 * crashed owner is released by the operating system without PID-file cleanup.
 */
export function acquireSqliteOwnerLease(
  databasePath: string,
  ownerName: string
): SqliteOwnerLease {
  const resolvedDatabasePath = assertAbsoluteDatabasePath(databasePath);
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(ownerName)) {
    throw new Error('sqlite_owner_lease_owner_name_invalid');
  }
  const leasePath = resolveSqliteOwnerLeasePath(resolvedDatabasePath);
  mkdirSync(path.dirname(leasePath), { recursive: true });

  const leaseDatabase = new DatabaseSync(leasePath);
  try {
    leaseDatabase.exec('PRAGMA busy_timeout = 0;');
    const mode = leaseDatabase.prepare('PRAGMA journal_mode = DELETE;').get() as {
      journal_mode: string;
    };
    if (mode.journal_mode.toLowerCase() !== 'delete') {
      throw new Error(`sqlite_owner_lease_journal_mode_invalid:${mode.journal_mode}`);
    }
    leaseDatabase.exec('BEGIN EXCLUSIVE;');
  } catch (error) {
    try {
      leaseDatabase.close();
    } catch {
      // The acquisition error is authoritative. Closing the connection still
      // asks SQLite/OS to release any partial lock before it becomes unreachable.
    }
    throw new Error(`sqlite_owner_lease_unavailable:${ownerName}`, { cause: error });
  }

  let closed = false;
  return {
    databasePath: resolvedDatabasePath,
    leasePath,
    close(): void {
      if (closed) return;
      closed = true;
      let rollbackError: unknown;
      try {
        if (leaseDatabase.isTransaction) leaseDatabase.exec('ROLLBACK;');
      } catch (error) {
        rollbackError = error;
      }
      try {
        leaseDatabase.close();
      } catch (closeError) {
        if (rollbackError !== undefined) {
          throw new AggregateError(
            [rollbackError, closeError],
            'sqlite_owner_lease_release_failed'
          );
        }
        throw closeError;
      }
      if (rollbackError !== undefined) throw rollbackError;
    }
  };
}

/**
 * Closes the business connection first and releases the owner lease only after
 * close is confirmed. A failed close keeps both objects strongly reachable and
 * fenced until process exit because the connection may still be live.
 */
export function closeOwnedSqliteDatabase(
  database: ClosableSqliteResource,
  ownerLease: SqliteOwnerLease
): void {
  try {
    database.close();
  } catch (error) {
    uncertainOwnedDatabases.add({ database, ownerLease });
    throw error;
  }
  ownerLease.close();
}

function assertAbsoluteDatabasePath(databasePath: string): string {
  if (typeof databasePath !== 'string' || databasePath.trim().length === 0) {
    throw new Error('sqlite_owner_lease_database_path_required');
  }
  if (!path.isAbsolute(databasePath)) {
    throw new Error('sqlite_owner_lease_database_path_invalid');
  }
  return path.resolve(databasePath);
}

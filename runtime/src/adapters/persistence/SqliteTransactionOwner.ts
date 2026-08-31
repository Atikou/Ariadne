import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { closeOwnedSqliteDatabase, type SqliteOwnerLease } from './SqliteOwnerLease.js';

export interface SqliteTransactionShutdownContext {
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  remainingMs(reserveMs?: number): number;
  throwIfExpired(code?: string): void;
}

export interface SqliteTransactionOwnerOptions {
  readonly shutdownRequestedCode: string;
  readonly closedCode: string;
  readonly shutdownConflictCode: string;
  readonly transactionActiveCode: string;
  readonly shutdownDeadlineCode: string;
  readonly beforeWriteCommit?: () => void;
  readonly afterWriteCommit?: () => void;
}

const transactionTails = new Map<string, Promise<void>>();

/** Owns serialization, BEGIN/COMMIT/ROLLBACK and the process SQLite lease. */
export class SqliteTransactionOwner {
  private static readonly closingOwners = new Set<SqliteTransactionOwner>();
  private readonly databaseKey: string;
  private lifecycle: 'open' | 'closing' | 'closed' = 'open';
  private readonly abortController = new AbortController();
  private lastScheduledOperation: Promise<void> = Promise.resolve();
  private shutdownContext: SqliteTransactionShutdownContext | null = null;
  private closePromise: Promise<void> | null = null;

  public constructor(
    public readonly database: DatabaseSync,
    databasePath: string,
    private readonly ownerLease: SqliteOwnerLease,
    private readonly options: SqliteTransactionOwnerOptions
  ) {
    const resolved = path.resolve(databasePath);
    this.databaseKey = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  public schedule<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.lifecycle !== 'open') {
      return Promise.reject(new Error(this.options.closedCode));
    }
    const signal = this.abortController.signal;
    const previous = transactionTails.get(this.databaseKey) ?? Promise.resolve();
    const result = previous.then(() => operation(signal), () => operation(signal));
    const tail = result.then(() => undefined, () => undefined);
    transactionTails.set(this.databaseKey, tail);
    this.lastScheduledOperation = tail;
    void tail.then(() => {
      if (transactionTails.get(this.databaseKey) === tail) {
        transactionTails.delete(this.databaseKey);
      }
    });
    return result;
  }

  public async transaction<T>(
    mode: 'read' | 'write',
    operation: () => T | Promise<T>,
    signal: AbortSignal
  ): Promise<T> {
    throwIfAborted(signal, this.options.shutdownRequestedCode);
    if (this.database.isTransaction) throw new Error(this.options.transactionActiveCode);
    this.database.exec(mode === 'write' ? 'BEGIN IMMEDIATE;' : 'BEGIN;');
    try {
      const result = await operation();
      throwIfAborted(signal, this.options.shutdownRequestedCode);
      if (mode === 'write') this.options.beforeWriteCommit?.();
      this.database.exec('COMMIT;');
      if (mode === 'write') this.options.afterWriteCommit?.();
      return result;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK;');
      throw error;
    }
  }

  public prepareShutdown(context: SqliteTransactionShutdownContext): void {
    if (this.lifecycle === 'closed') {
      context.throwIfExpired(this.options.shutdownDeadlineCode);
      return;
    }
    if (this.lifecycle === 'open') {
      this.lifecycle = 'closing';
      SqliteTransactionOwner.closingOwners.add(this);
      this.shutdownContext = context;
      this.abortController.abort(new Error(this.options.shutdownRequestedCode));
    } else if (this.shutdownContext !== context) {
      throw new Error(this.options.shutdownConflictCode);
    }
    context.throwIfExpired(this.options.shutdownDeadlineCode);
  }

  public close(context: SqliteTransactionShutdownContext): Promise<void> {
    if (this.lifecycle === 'closed') return Promise.resolve();
    if (this.closePromise !== null) return this.closePromise;
    try {
      this.prepareShutdown(context);
    } catch (error) {
      return Promise.reject(error);
    }
    this.closePromise = this.closeAfterDrain(context);
    return this.closePromise;
  }

  private async closeAfterDrain(context: SqliteTransactionShutdownContext): Promise<void> {
    await waitForDrain(this.lastScheduledOperation, context, this.options.shutdownDeadlineCode);
    context.throwIfExpired(this.options.shutdownDeadlineCode);
    closeOwnedSqliteDatabase(this.database, this.ownerLease);
    this.lifecycle = 'closed';
    SqliteTransactionOwner.closingOwners.delete(this);
  }
}

function throwIfAborted(signal: AbortSignal, fallbackCode: string): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error(fallbackCode);
}

async function waitForDrain(
  drain: Promise<void>,
  context: SqliteTransactionShutdownContext,
  deadlineCode: string
): Promise<void> {
  context.throwIfExpired(deadlineCode);
  const remaining = context.remainingMs();
  if (remaining <= 0) throw new Error(deadlineCode);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    const fail = (): void => reject(new Error(deadlineCode));
    onAbort = fail;
    if (context.signal.aborted) return fail();
    context.signal.addEventListener('abort', fail, { once: true });
    timer = setTimeout(fail, Math.min(remaining, 2_147_483_647));
    timer.unref?.();
  });
  try {
    await Promise.race([drain, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) context.signal.removeEventListener('abort', onAbort);
  }
}

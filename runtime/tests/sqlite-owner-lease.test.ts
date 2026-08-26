import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  acquireSqliteOwnerLease,
  closeOwnedSqliteDatabase,
  resolveSqliteOwnerLeasePath,
  type SqliteOwnerLease
} from '../src/adapters/persistence/SqliteOwnerLease.js';
import { SqliteAgentRunUnitOfWork } from '../src/adapters/persistence/SqliteAgentRunUnitOfWork.js';
import { resolveAgentControlDatabasePath } from '../src/adapters/persistence/agentControlDbSchema.js';
import { resolveRuntimeCommandDatabasePath } from '../src/adapters/persistence/runtimeCommandDbMigrations.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';

const roots: string[] = [];
const leases = new Set<SqliteOwnerLease>();
const children = new Set<ChildProcessWithoutNullStreams>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await waitForExit(child);
    }
  }
  children.clear();
  for (const lease of leases) lease.close();
  leases.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('SqliteOwnerLease', () => {
  it('allows exactly one same-process owner and can reopen after close', () => {
    const databasePath = resolveRuntimeCommandDatabasePath(createRoot());
    const first = trackLease(acquireSqliteOwnerLease(databasePath, 'first-owner'));

    expect(() => acquireSqliteOwnerLease(databasePath, 'second-owner'))
      .toThrow(/sqlite_owner_lease_unavailable:second-owner/);

    closeLease(first);
    const reopened = trackLease(acquireSqliteOwnerLease(databasePath, 'reopened-owner'));
    expect(reopened.leasePath).toBe(resolveSqliteOwnerLeasePath(databasePath));
  });

  it('fails closed while a real child holds the lease and recovers after child kill', async () => {
    const root = createRoot();
    const databasePath = resolveAgentControlDatabasePath(root);
    const child = spawnLeaseHolder(resolveSqliteOwnerLeasePath(databasePath));
    children.add(child);
    await waitForLine(child, 'LEASE_ACQUIRED');

    const startedAt = Date.now();
    expect(() => new SqliteAgentRunUnitOfWork(root))
      .toThrow(/sqlite_owner_lease_unavailable:agent-control/);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(existsSync(databasePath)).toBe(false);

    child.kill();
    await waitForExit(child);
    children.delete(child);
    const recovered = new SqliteAgentRunUnitOfWork(root);
    await closeUnitOfWork(recovered);
    expect(existsSync(databasePath)).toBe(true);
  });

  it('does not interlock different stores or the same store under another data root', () => {
    const firstRoot = createRoot();
    const secondRoot = createRoot();
    const runtimeLease = trackLease(acquireSqliteOwnerLease(
      resolveRuntimeCommandDatabasePath(firstRoot),
      'runtime-owner'
    ));
    const agentLease = trackLease(acquireSqliteOwnerLease(
      resolveAgentControlDatabasePath(firstRoot),
      'agent-owner'
    ));
    const otherRuntimeLease = trackLease(acquireSqliteOwnerLease(
      resolveRuntimeCommandDatabasePath(secondRoot),
      'other-runtime-owner'
    ));

    expect(new Set([
      runtimeLease.leasePath,
      agentLease.leasePath,
      otherRuntimeLease.leasePath
    ]).size).toBe(3);
  });

  it('keeps a failed business close fenced until the owning process exits', async () => {
    const root = createRoot();
    const child = spawnFailedCloseOwner(root);
    children.add(child);
    await waitForLine(child, 'CLOSE_FAILED_AND_FENCED');

    expect(() => new SqliteAgentRunUnitOfWork(root))
      .toThrow(/sqlite_owner_lease_unavailable:agent-control/);

    child.kill();
    await waitForExit(child);
    children.delete(child);
    const recovered = new SqliteAgentRunUnitOfWork(root);
    await closeUnitOfWork(recovered);
  });

  it('does not release ownership when the business database close is uncertain', () => {
    let leaseCloseCalls = 0;
    expect(() => closeOwnedSqliteDatabase({
      close(): void {
        throw new Error('business_database_close_failed');
      }
    }, {
      databasePath: 'C:\\business.db',
      leasePath: 'C:\\business.db.owner-lock',
      close(): void {
        leaseCloseCalls += 1;
      }
    })).toThrow(/business_database_close_failed/);
    expect(leaseCloseCalls).toBe(0);
  });
});

function createRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-owner-lease-'));
  roots.push(root);
  return root;
}

function trackLease(lease: SqliteOwnerLease): SqliteOwnerLease {
  leases.add(lease);
  return lease;
}

function closeLease(lease: SqliteOwnerLease): void {
  if (!leases.delete(lease)) return;
  lease.close();
}

function spawnLeaseHolder(leasePath: string): ChildProcessWithoutNullStreams {
  mkdirSync(path.dirname(leasePath), { recursive: true });
  const script = String.raw`
    const { DatabaseSync } = require('node:sqlite');
    const database = new DatabaseSync(process.argv[1]);
    database.exec('PRAGMA busy_timeout = 0;');
    const mode = database.prepare('PRAGMA journal_mode = DELETE;').get();
    if (String(mode.journal_mode).toLowerCase() !== 'delete') process.exit(41);
    database.exec('BEGIN EXCLUSIVE;');
    process.stdout.write('LEASE_ACQUIRED\n');
    setInterval(() => {}, 10_000);
  `;
  return spawn(process.execPath, ['-e', script, leasePath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
}

function spawnFailedCloseOwner(root: string): ChildProcessWithoutNullStreams {
  const script = String.raw`
    import { SqliteAgentRunUnitOfWork } from './src/adapters/persistence/SqliteAgentRunUnitOfWork.ts';
    import { createShutdownContext } from './src/ingress/ShutdownContext.ts';
    const root = process.argv[1];
    const owner = new SqliteAgentRunUnitOfWork(root);
    const database = owner.database;
    Object.defineProperty(database, 'close', {
      configurable: true,
      value() { throw new Error('simulated_business_close_failure'); }
    });
    try {
      await owner.close(createShutdownContext(Date.now() + 5_000));
      process.exit(42);
    } catch (error) {
      if (!String(error).includes('simulated_business_close_failure')) process.exit(43);
    }
    try {
      new SqliteAgentRunUnitOfWork(root);
      process.exit(44);
    } catch (error) {
      if (!String(error).includes('sqlite_owner_lease_unavailable:agent-control')) {
        process.exit(45);
      }
    }
    process.stdout.write('CLOSE_FAILED_AND_FENCED\n');
    setInterval(() => {}, 10_000);
  `;
  return spawn(process.execPath, [
    '--import',
    'tsx',
    '--input-type=module',
    '-e',
    script,
    root
  ], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
}

async function closeUnitOfWork(unitOfWork: SqliteAgentRunUnitOfWork): Promise<void> {
  const context = createShutdownContext(Date.now() + 5_000);
  try {
    await unitOfWork.close(context);
  } finally {
    context.dispose();
  }
}

function waitForLine(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`lease_child_timeout:${stdout}:${stderr}`));
    }, 5_000);
    const onStdout = (chunk: Buffer): void => {
      stdout += chunk.toString('utf8');
      if (stdout.includes(`${expected}\n`)) {
        cleanup();
        resolve();
      }
    };
    const onStderr = (chunk: Buffer): void => {
      stderr += chunk.toString('utf8');
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`lease_child_exited:${String(code)}:${String(signal)}:${stderr}`));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('exit', onExit);
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { observeWindowsParentExit } from '../src/main/runtime/windows-parent-exit-observer';

describe.runIf(process.platform === 'win32')('native Windows process-handle exit evidence', () => {
  it('holds the exclusive OS lease through exit observation until explicitly released', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'AriadneParentLease-'))), lock = join(root, 'owner.lock');
    const child = spawn(process.execPath, ['-e', 'process.on("message", code => process.exit(code));'],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let observer: Awaited<ReturnType<typeof observeWindowsParentExit>> | undefined;
    try {
      if (!child.pid) throw new Error('Missing fixture process.');
      observer = await observeWindowsParentExit(child.pid, lock);
      await expect(observeWindowsParentExit(process.pid, lock)).rejects.toThrow('restore_parent_exit_unconfirmed');
      child.send(0); await expect(observer.exited).resolves.toBe(0);
      await expect(observeWindowsParentExit(process.pid, lock)).rejects.toThrow('restore_parent_exit_unconfirmed');
      await observer.release();
      const next = await observeWindowsParentExit(process.pid, lock, { lifetime: 'owner-process' }); await next.release();
    } finally {
      await observer?.release(); if (child.exitCode === null && child.signalCode === null) child.kill();
      if (dirname(root) !== await realpath(tmpdir()) || !basename(root).startsWith('AriadneParentLease-') || await realpath(root) !== root)
        throw new Error('Unsafe fixture cleanup.');
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
  it.each([0, 7])('observes actual parent exit code %s from a handle opened before exit', async code => {
    const child = spawn(process.execPath, ['-e', 'process.on("message", code => process.exit(code));'],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    try {
      if (!child.pid) throw new Error('Missing fixture process.');
      const observer = await observeWindowsParentExit(child.pid);
      child.send(code);
      await expect(observer.exited).resolves.toBe(code);
      observer.dispose();
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
  }, 20_000);
  it('binds an optional executable identity to the retained native process handle', async () => {
    const child = spawn(process.execPath, ['-e', 'process.on("message", code => process.exit(code));'],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let observer: Awaited<ReturnType<typeof observeWindowsParentExit>> | undefined;
    try {
      if (!child.pid) throw new Error('Missing fixture process.');
      await expect(observeWindowsParentExit(child.pid, undefined, { expectedExecutable: process.execPath + '.wrong-executable' }))
        .rejects.toThrow('restore_parent_exit_unconfirmed');
      expect(child.exitCode).toBeNull();
      observer = await observeWindowsParentExit(child.pid, undefined, { expectedExecutable: await realpath(process.execPath) });
      child.send(0); await expect(observer.exited).resolves.toBe(0);
    } finally { await observer?.release(); if (child.exitCode === null && child.signalCode === null) child.kill(); }
  }, 20_000);
  it('does not treat IPC disconnect as exit or permit a nonexistent PID', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    try {
      if (!child.pid) throw new Error('Missing fixture process.');
      const observer = await observeWindowsParentExit(child.pid);
      child.disconnect();
      let exited = false; void observer.exited.then(() => { exited = true; });
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(exited).toBe(false);
      child.kill(); await observer.exited;
      observer.dispose();
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
    await expect(observeWindowsParentExit(2_147_483_647)).rejects.toThrow('restore_parent_exit_unconfirmed');
  }, 20_000);
});

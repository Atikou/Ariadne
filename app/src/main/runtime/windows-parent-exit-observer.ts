import { spawn } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';

export interface ObservedParentExit { exited: Promise<number>; dispose(): void; release(): Promise<void> }

/** Opens the actual Windows process handle before reporting readiness. The
 * retained handle observes that process's exit code even if its PID is reused.
 * IPC disconnect alone is never accepted as evidence of a clean Main exit. */
export function observeWindowsParentExit(parentPid: number, switchLockPath?: string,
  options?: { lifetime?: 'owner-process'; expectedExecutable?: string }): Promise<ObservedParentExit> {
  if (process.platform !== 'win32' || !Number.isSafeInteger(parentPid) || parentPid < 1
    || !process.env.SystemRoot || !isAbsolute(process.env.SystemRoot)
    || (switchLockPath !== undefined && !isAbsolute(switchLockPath))
    || (options?.expectedExecutable !== undefined && !isAbsolute(options.expectedExecutable)))
    return Promise.reject(new Error('restore_parent_observation_unavailable'));
  const executable = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = "$ErrorActionPreference='Stop';try { $taskInput=[Console]::In.ReadLine()|ConvertFrom-Json;"
    + "if($taskInput.lockPath){$taskLock=[IO.File]::Open($taskInput.lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);if($taskLock.Length -ne 0){exit 2}};"
    + "$taskProcess=[Diagnostics.Process]::GetProcessById([int]$taskInput.pid);$taskHandle=$taskProcess.Handle;"
    + "if($taskInput.expectedExecutable -and -not [StringComparer]::OrdinalIgnoreCase.Equals($taskProcess.MainModule.FileName,[string]$taskInput.expectedExecutable)){throw 'Unexpected process executable'};"
    + "[Console]::Out.WriteLine('READY');[Console]::Out.Flush();"
    + "if($taskInput.lockPath){Add-Type 'using System;using System.Threading.Tasks;public static class AriadneParentPipe {public static Task<string> ReadRelease(){return Task.Run(()=>Console.In.ReadLine());}}';$taskRelease=[AriadneParentPipe]::ReadRelease()};$taskClock=[Diagnostics.Stopwatch]::StartNew();"
    + "while(-not $taskProcess.WaitForExit(100)){if(-not $taskInput.ownerLifetime -and $taskClock.ElapsedMilliseconds -gt 300000){exit 2};if($taskInput.lockPath -and $taskRelease.IsCompleted){exit 3}};"
    + "[Console]::Out.WriteLine($taskProcess.ExitCode);[Console]::Out.Flush();$taskProcess.Dispose();"
    + "if($taskInput.lockPath){$null=$taskRelease.GetAwaiter().GetResult();$taskLock.Dispose()}"
    + "}catch {exit 2}";
  return new Promise((resolve, reject) => {
    const observer = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let ready = false, result: number | null = null, fault = false;
    let exitResolve!: (code: number) => void, exitReject!: (error: Error) => void;
    const exited = new Promise<number>((yes, no) => { exitResolve = yes; exitReject = no; });
    // An early process failure may occur before the readiness promise returns.
    void exited.catch(() => undefined);
    const lines = createInterface({ input: observer.stdout });
    const closed = new Promise<void>(done => observer.once('close', () => done()));
    const stop = () => { if (observer.exitCode === null && observer.signalCode === null) observer.kill(); };
    const release = async (): Promise<void> => { stop(); await closed; };
    const timer = options?.lifetime === 'owner-process' ? undefined : setTimeout(() => { fault = true; stop(); }, 310_000);
    const readinessTimer = setTimeout(() => { fault = true; stop(); }, 10_000);
    observer.on('error', () => { fault = true; stop(); });
    observer.stdin.on('error', () => { fault = true; stop(); });
    lines.on('line', value => {
      if (!ready && value === 'READY') { ready = true; clearTimeout(readinessTimer); resolve({ exited, dispose: stop, release }); return; }
      if (!ready || result !== null || !/^-?\d{1,10}$/u.test(value)) { fault = true; stop(); return; }
      result = Number(value);
      exitResolve(result);
    });
    observer.on('close', code => {
      clearTimeout(timer); clearTimeout(readinessTimer); lines.close();
      if (fault || code !== 0 || result === null) {
        const error = new Error('restore_parent_exit_unconfirmed'); reject(error); exitReject(error);
      } else exitResolve(result);
    });
    observer.stdin.write(JSON.stringify({ pid: parentPid, ownerLifetime: options?.lifetime === 'owner-process',
      ...(options?.expectedExecutable ? { expectedExecutable: options.expectedExecutable } : {}), ...(switchLockPath ? { lockPath: switchLockPath } : {}) }) + '\n');
    if (!switchLockPath) observer.stdin.end();
  });
}

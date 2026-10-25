import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { dataRootSwitchArmSchema, dataRootSwitchPrepareSchema, dataRootSwitchResponseSchema } from './data-root-switch-contract';
import type { DataRootRecoveryChoice } from '../data-management/data-root-switch-journal';

export interface PreparedDataRootSwitchWorker { readonly pid: number; arm(): Promise<void>; cancel(): Promise<void> }
/** The ready acknowledgement means the helper has opened the exact parent
 * process handle and acquired the OS switch lock. An arm acknowledgement must
 * precede Main's actual exit; its clean exit code remains mandatory afterwards. */
export async function prepareDataRootSwitchWorker(input: { executable: string; entry: string; dataRoot: string;
  operationId: string; choice: DataRootRecoveryChoice; relaunch?: { executable: string; appPath: string; packaged: boolean } }): Promise<PreparedDataRootSwitchWorker> {
  if (![input.executable, input.entry, input.dataRoot].every(isAbsolute)) throw new Error('restore_worker_path_invalid');
  const request = dataRootSwitchPrepareSchema.parse({ protocol: 'ariadne_data_root_switch.v1', type: 'prepare',
    dataRoot: input.dataRoot, operationId: input.operationId, choice: input.choice, ...(input.relaunch ? { relaunch: input.relaunch } : {}) });
  const child = spawn(input.executable, [input.entry], { detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
  child.stdout?.resume(); child.stderr?.resume();
  let phase: 'preparing' | 'ready' | 'arming' | 'armed' | 'closed' = 'preparing';
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  let armResolve!: () => void, armReject!: (error: Error) => void;
  const ready = new Promise<void>((yes, no) => { readyResolve = yes; readyReject = no; });
  const armed = new Promise<void>((yes, no) => { armResolve = yes; armReject = no; });
  void armed.catch(() => undefined);
  let closeResolve!: () => void; const closed = new Promise<void>(yes => { closeResolve = yes; });
  const fail = () => {
    const error = new Error('restore_worker_prepare_failed'); readyReject(error); armReject(error);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  };
  const timer = setTimeout(fail, 20_000);
  child.on('error', fail);
  child.on('message', raw => {
    const parsed = dataRootSwitchResponseSchema.safeParse(raw);
    if (!parsed.success || parsed.data.operationId !== input.operationId) { fail(); return; }
    if (parsed.data.type === 'ready' && phase === 'preparing') { phase = 'ready'; clearTimeout(timer); readyResolve(); }
    else if (parsed.data.type === 'armed' && phase === 'arming') { phase = 'armed'; armResolve(); }
    else fail();
  });
  child.on('close', () => { phase = 'closed'; clearTimeout(timer); readyReject(new Error('restore_worker_closed')); armReject(new Error('restore_worker_closed')); closeResolve(); });
  child.send(request, error => { if (error) fail(); });
  try { await ready; }
  catch (error) { await closed; throw error; }
  return {
    pid: child.pid!,
    arm: async () => {
      if (phase !== 'ready') throw new Error('restore_worker_not_ready');
      phase = 'arming'; const deadline = setTimeout(fail, 10_000);
      child.send(dataRootSwitchArmSchema.parse({ protocol: 'ariadne_data_root_switch.v1', type: 'arm', operationId: input.operationId }), error => { if (error) fail(); });
      try { await armed; } finally { clearTimeout(deadline); }
      // Main is about to exit. No inherited stdio or IPC keeps it alive.
      child.unref(); child.stdout?.destroy(); child.stderr?.destroy(); child.channel?.unref();
    },
    cancel: async () => { if (phase !== 'closed') fail(); await closed; }
  };
}

import { app, dialog } from 'electron';
import { existsSync, mkdtempSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { inspectDataRootSwitch } from '../data-management/data-root-switch-journal';
import { prepareDataRootSwitchWorker } from './data-root-switch-worker';
import { resolveDesktopNodeExecutable } from './runtime-configuration';

export function dataRootSwitchHelperEntry(appPath: string, packaged: boolean): string {
  return join(packaged && appPath.endsWith('.asar') ? appPath + '.unpacked' : appPath, 'out', 'main', 'data-root-switch-process.cjs');
}
export function hasDataRootSwitchJournal(dataRoot: string): boolean {
  return existsSync(join(dirname(dataRoot), '.' + basename(dataRoot) + '.ariadne-restore-journal.json'));
}

/** Must be called synchronously before app ready. An unfinished restore gets a
 * new UI-only Chromium profile so startup cannot recreate a missing original
 * directory, write cache files into a validated candidate, or start Actors. */
export function prepareDataRootRecoveryStartup(): { run(): Promise<void> } | null {
  const dataRoot = app.getPath('userData');
  if (!hasDataRootSwitchJournal(dataRoot)) return null;
  const profile = mkdtempSync(join(app.getPath('temp'), 'AriadneRecoveryChoice-'));
  app.setPath('userData', profile); app.setPath('sessionData', profile);
  return { run: async () => {
    await app.whenReady();
    const inspection = await inspectDataRootSwitch(dataRoot);
    if (!inspection) throw new Error('restore_startup_journal_missing');
    const choice = await dialog.showMessageBox({ type: 'warning', title: '完成数据恢复',
      message: '检测到尚未结算的数据目录恢复。',
      detail: '原目录与已经验证的恢复目录均予以保留。请选择本次启动使用的目录；选择后应用会退出、完成切换并重新启动。',
      buttons: ['使用原目录', '使用已验证的恢复目录', '暂不启动'], defaultId: 0, cancelId: 2, noLink: true });
    if (choice.response === 2) { app.exit(0); return; }
    const worker = await prepareDataRootSwitchWorker({ executable: resolveDesktopNodeExecutable({ packaged: app.isPackaged,
      resourcesPath: process.resourcesPath, executablePath: process.execPath }),
      entry: dataRootSwitchHelperEntry(app.getAppPath(), app.isPackaged), dataRoot,
      operationId: inspection.journal.operationId, choice: choice.response === 0 ? 'original' : 'replacement',
      relaunch: { executable: process.execPath, appPath: app.getAppPath(), packaged: app.isPackaged } });
    await worker.arm(); app.exit(0);
  } };
}

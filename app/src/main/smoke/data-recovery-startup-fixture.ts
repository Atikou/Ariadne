import { app, dialog } from 'electron';
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/** Native recovery choice supplied only on a canonical test-owned profile.
 * Original index/recovery/helper paths run unchanged; no physical dialog. */
export function installDataRecoveryStartupFixture(): void {
  const choice = process.env.ARIADNE_SMOKE_DATA_RECOVERY_CHOICE;
  if (choice === undefined) return;
  const root = app.getPath('userData'), parent = dirname(root), output = process.env.ARIADNE_SMOKE_TEST_OUTPUT;
  if (!app.isPackaged || process.env.ARIADNE_SMOKE_TEST !== '1' || !['original', 'replacement', 'cancel'].includes(choice)
    || basename(root) !== 'profile' || !basename(parent).startsWith('AriadneRecoveryColdStart-')
    || dirname(parent) !== realpathSync.native(tmpdir()) || realpathSync.native(root) !== root || lstatSync(root).isSymbolicLink()
    || output !== join(parent, 'evidence')) throw new Error('data_recovery_startup_fixture_scope_invalid');
  mkdirSync(output, { recursive: true });
  if (realpathSync.native(output) !== output) throw new Error('data_recovery_startup_fixture_scope_invalid');
  dialog.showMessageBox = (async (...args: unknown[]) => {
    const options = args.at(-1) as Electron.MessageBoxOptions;
    if (options.title !== '完成数据恢复' || options.defaultId !== 0 || options.cancelId !== 2)
      throw new Error('data_recovery_startup_fixture_dialog_invalid');
    writeFileSync(join(output, 'startup-recovery-choice.json'), JSON.stringify({ choice, mainPid: process.pid,
      recoveryChoiceProfile: app.getPath('userData'), originalStartupRecoveryPath: true, originalApplicationOwnersStarted: false,
      nativeDialogSelection: 'isolated fixture', physicalInteraction: false }, null, 2));
    delete process.env.ARIADNE_SMOKE_DATA_RECOVERY_CHOICE;
    return { response: choice === 'original' ? 0 : choice === 'replacement' ? 1 : 2, checkboxChecked: false };
  }) as typeof dialog.showMessageBox;
}

import { app, Notification } from 'electron';
import { isAbsolute } from 'node:path';
import { ApplicationController } from './application';
import { installProjectionCapacityMetrics } from './smoke/projection-capacity-metrics';
import { parseDecisionNotificationActivation } from './services/decision-notification-activation';
import { parseTaskNotificationActivation } from './services/task-notification-activation';
import { DraftQuitBlockedError } from './services/renderer-draft-quit';
import { isElectronBackupValidationProcess, startElectronBackupValidationProcess } from './runtime/electron-backup-validation-process';
import { hasDataRootSwitchJournal, prepareDataRootRecoveryStartup } from './runtime/data-root-recovery-startup';
import { acquireDataRootOwnerLease } from './runtime/data-root-owner-lease';
import { installDataRecoveryStartupFixture } from './smoke/data-recovery-startup-fixture';

if (isElectronBackupValidationProcess()) {
  startElectronBackupValidationProcess();
} else {

const smokeUserData = process.env.ARIADNE_SMOKE_USER_DATA;
const isSmokeTest = process.env.ARIADNE_SMOKE_TEST === '1' && Boolean(smokeUserData);
if (isSmokeTest && smokeUserData) {
  if (!isAbsolute(smokeUserData)) throw new Error('ARIADNE_SMOKE_USER_DATA must be absolute.');
  app.setPath('userData', smokeUserData);
  app.setPath('sessionData', smokeUserData);
  if (process.env.ARIADNE_SMOKE_PROJECTION_CAPACITY === '1') installProjectionCapacityMetrics();
}

if (process.platform === 'win32') app.setAppUserModelId('com.ariadne.desktop');
if (app.isPackaged && !isSmokeTest) app.setAsDefaultProtocolClient('ariadne');

const originalDataRoot = app.getPath('userData');
installDataRecoveryStartupFixture();
const recoveryStartup = prepareDataRootRecoveryStartup();

const hasSingleInstanceLock = isSmokeTest || app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  void startOriginalApplication().catch(() => {
    console.error('Application data owners could not be admitted.'); app.exit(1);
  });

  async function startOriginalApplication(): Promise<void> {
  if (recoveryStartup) { await recoveryStartup.run(); return; }
  await app.whenReady();
  const ownerLease = process.platform === 'win32' ? await acquireDataRootOwnerLease(originalDataRoot) : null;
  let ownerLeaseReleased = false;
  void ownerLease?.exited.catch(() => { if (!ownerLeaseReleased) { console.error('Application profile owner lease was lost.'); app.exit(1); } });
  app.once('will-quit', () => { ownerLeaseReleased = true; ownerLease?.dispose(); });
  // A journal can appear while this launch waits for readiness. Do not create
  // owners under it; another launch will enter the separate recovery profile.
  if (hasDataRootSwitchJournal(originalDataRoot)) { ownerLeaseReleased = true; ownerLease?.dispose(); app.exit(1); return; }
  const application = new ApplicationController();
  let quitPrepared = false;
  let quitPreparation: Promise<void> | null = null;

  const showFromUserAction = (): void => {
    void application.showFromUserAction().catch((error: unknown) => {
      console.error('Application could not be shown.', error);
    });
  };
  const handleOpenUrl = (url: string): void => {
    void application.handleOpenUrl(url)
      .then(() => application.showFromUserAction())
      .catch((error: unknown) => {
        console.error('Rejected MCP OAuth callback.', error);
      });
  };
  app.on('second-instance', (_event, argv) => {
    const callback = findMcpOAuthCallback(argv);
    if (callback) handleOpenUrl(callback);
    else showFromUserAction();
  });
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleOpenUrl(url);
  });
  app.on('activate', showFromUserAction);
  app.on('before-quit', (event) => {
    if (quitPrepared) return;
    event.preventDefault();
    quitPreparation ??= application.prepareToQuit()
      .then(() => {
        quitPrepared = true;
        app.quit();
      })
      .catch((error: unknown) => {
        if (error instanceof DraftQuitBlockedError) {
          quitPreparation = null;
          console.error('Quit cancelled; editable drafts and windows are retained.');
          showFromUserAction();
          return;
        }
        console.error('Application cleanup failed.', error);
        app.exit(1);
      });
  });

  void app.whenReady()
    .then(async () => {
      if (process.platform === 'win32') Notification.handleActivation(details => {
        const reference = parseDecisionNotificationActivation(details);
        if (reference) void application.activateDecisionNotification(reference)
          .catch(() => { console.error('Notification activation could not be completed.'); });
        const task = parseTaskNotificationActivation(details);
        if (task) void application.activateTaskNotification(task)
          .catch(() => { console.error('Task notification activation could not be completed.'); });
      });
      await application.start();
      const startupCallback = findMcpOAuthCallback(process.argv);
      if (startupCallback) {
        await application.handleOpenUrl(startupCallback).catch((error: unknown) => {
          console.error('Rejected startup MCP OAuth callback.', error);
        });
      }
      const smokeOutput = process.env.ARIADNE_SMOKE_TEST_OUTPUT;
      if (process.env.ARIADNE_SMOKE_TEST === '1' && smokeOutput) {
        let exitCode = 1;
        try {
          exitCode = await application.runSmokeTest(smokeOutput) ? 0 : 1;
        } catch (error: unknown) {
          console.error('Electron smoke verification failed.', error);
        }
        process.exitCode = exitCode;
        if (process.env.ARIADNE_SMOKE_FORCE_MAIN_CRASH_AFTER_RESULT !== '1') app.quit();
      }
    })
    .catch((error: unknown) => {
      console.error('Application startup failed.', error);
      process.exitCode = 1;
      app.quit();
    });
  }
}

}

function findMcpOAuthCallback(values: readonly string[]): string | undefined {
  return values.find((value) => /^ariadne:\/\/oauth\/mcp(?:[?#]|$)/u.test(value));
}

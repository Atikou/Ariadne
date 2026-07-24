import { app } from 'electron';
import { isAbsolute } from 'node:path';
import { ApplicationController } from './application';

const smokeUserData = process.env.ARIADNE_SMOKE_USER_DATA;
const isSmokeTest = process.env.ARIADNE_SMOKE_TEST === '1' && Boolean(smokeUserData);
if (isSmokeTest && smokeUserData) {
  if (!isAbsolute(smokeUserData)) throw new Error('ARIADNE_SMOKE_USER_DATA must be absolute.');
  app.setPath('userData', smokeUserData);
}

if (process.platform === 'win32') app.setAppUserModelId('com.ariadne.desktop');

const hasSingleInstanceLock = isSmokeTest || app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  const application = new ApplicationController();
  let quitPrepared = false;
  let quitPreparation: Promise<void> | null = null;

  const showFromUserAction = (): void => {
    void application.showFromUserAction().catch((error: unknown) => {
      console.error('Application could not be shown.', error);
    });
  };
  app.on('second-instance', showFromUserAction);
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
        console.error('Application cleanup failed.', error);
        app.exit(1);
      });
  });

  void app.whenReady()
    .then(async () => {
      await application.start();
      const smokeOutput = process.env.ARIADNE_SMOKE_TEST_OUTPUT;
      if (process.env.ARIADNE_SMOKE_TEST === '1' && smokeOutput) {
        let exitCode = 1;
        try {
          exitCode = await application.runSmokeTest(smokeOutput) ? 0 : 1;
        } catch (error: unknown) {
          console.error('Electron smoke verification failed.', error);
        }
        process.exitCode = exitCode;
        app.quit();
      }
    })
    .catch((error: unknown) => {
      console.error('Application startup failed.', error);
      process.exitCode = 1;
      app.quit();
    });
}

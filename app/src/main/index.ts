import { app } from 'electron';
import { ApplicationController } from './application';

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  const application = new ApplicationController();

  app.on('second-instance', () => void application.showFromUserAction());
  app.on('activate', () => void application.showFromUserAction());
  app.on('before-quit', (event) => {
    event.preventDefault();
    void application.prepareToQuit().finally(() => app.exit(0));
  });

  void app.whenReady().then(() => application.start());
}

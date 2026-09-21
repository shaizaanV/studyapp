'use strict';

const { autoUpdater } = require('electron-updater');
const { dialog } = require('electron');

/** How often to poll for a new release once the app is running. */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * Wraps electron-updater: a startup check, a 4-hour poll, and a native
 * restart-or-later prompt once a build has finished downloading. The feed is
 * the public GitHub Releases config baked into app-update.yml at build time
 * (see electron-builder.yml's `publish` key) -- no token, no private-repo
 * auth, nothing that could leak from the shipped binary.
 */
function createUpdateManager({ getParentWindow = () => null, log = console } = {}) {
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;

  autoUpdater.on('error', (err) => {
    log.error?.('[update-manager] error', err);
  });

  autoUpdater.on('update-downloaded', (info) => {
    dialog
      .showMessageBox(getParentWindow(), {
        type: 'info',
        title: 'Update ready',
        message: `Flowcus ${info.version} has been downloaded.`,
        detail: 'Restart now to install it, or keep working -- it installs automatically on your next launch.',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
  });

  let intervalHandle = null;

  function checkNow() {
    autoUpdater.checkForUpdates().catch((err) => log.error?.('[update-manager] checkForUpdates failed', err));
  }

  function start() {
    checkNow();
    // Referenced on purpose, matching the timer engine's own interval: this
    // must not let the process exit out from under a check in flight.
    intervalHandle = setInterval(checkNow, CHECK_INTERVAL_MS);
  }

  function stop() {
    if (!intervalHandle) return;
    clearInterval(intervalHandle);
    intervalHandle = null;
  }

  return { start, stop };
}

module.exports = { createUpdateManager };

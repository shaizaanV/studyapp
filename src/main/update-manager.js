'use strict';

/** How often to poll for a new release once the app is running. */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * Wraps electron-updater: a startup check, a 4-hour poll, and a native
 * restart-or-later prompt once a build has finished downloading. The feed is
 * the public GitHub Releases config baked into app-update.yml at build time
 * (see electron-builder.yml's `publish` key) -- no token, no private-repo
 * auth, nothing that could leak from the shipped binary.
 *
 * `requireUpdate()` is the stricter path used when the room relay says this
 * build is too old: it skips the "later" option, downloads if needed, and
 * installs as soon as the download lands.
 *
 * The Microsoft Store build never self-updates (the Store delivers its updates),
 * so there `electron-updater` is not even loaded: start/stop do nothing and the
 * "update required" prompt points at the Store instead.
 *
 * `updater`, `dialog` and `store` are injectable so the flow can be tested
 * without Electron.
 */
const STORE_UPDATES_URI = 'ms-windows-store://downloadsandupdates';

function createUpdateManager({
  getParentWindow = () => null,
  log = console,
  store = Boolean(process.windowsStore),
  updater = store ? null : require('electron-updater').autoUpdater,
  dialog = require('electron').dialog,
  shell = require('electron').shell,
  isPackaged = () => require('electron').app.isPackaged,
} = {}) {
  if (store) return createStoreUpdateManager({ getParentWindow, dialog, shell });

  updater.logger = log;
  updater.autoDownload = true;

  let downloaded = false;
  let installWhenReady = false;
  let intervalHandle = null;

  updater.on('error', (err) => {
    log.error?.('[update-manager] error', err);
    if (installWhenReady) {
      installWhenReady = false;
      dialog.showMessageBox(getParentWindow(), {
        type: 'warning',
        title: 'Update failed',
        message: 'Focuvibe could not download the update.',
        detail: 'Check your connection and relaunch the app to try again, or download the latest installer from the releases page.',
        buttons: ['OK'],
        noLink: true,
      });
    }
  });

  updater.on('update-downloaded', (info) => {
    downloaded = true;
    if (installWhenReady) {
      updater.quitAndInstall(false, true);
      return;
    }
    dialog
      .showMessageBox(getParentWindow(), {
        type: 'info',
        title: 'Update ready',
        message: `Focuvibe ${info.version} has been downloaded.`,
        detail: 'Restart now to install it, or keep working -- it installs automatically on your next launch.',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      .then(({ response }) => {
        if (response === 0) updater.quitAndInstall();
      });
  });

  updater.on('update-not-available', () => {
    if (!installWhenReady) return;
    installWhenReady = false;
    dialog.showMessageBox(getParentWindow(), {
      type: 'info',
      title: 'No update found',
      message: 'No newer build is published yet.',
      detail: 'Study rooms need a newer version than the one you have. Try again in a little while.',
      buttons: ['OK'],
      noLink: true,
    });
  });

  function checkNow() {
    return updater.checkForUpdates().catch((err) => log.error?.('[update-manager] checkForUpdates failed', err));
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

  /**
   * Installs the newest build with no "later" option. Resolves to
   * 'installing' (already downloaded), 'checking' (will install when the
   * download lands) or 'unsupported' (a development run cannot self-update).
   */
  async function requireUpdate() {
    if (!isPackaged()) return 'unsupported';
    if (downloaded) {
      updater.quitAndInstall(false, true);
      return 'installing';
    }
    installWhenReady = true;
    await checkNow();
    return 'checking';
  }

  let prompting = false;

  /** The blocking "your version is not supported" dialog. One at a time. */
  async function promptUnsupported() {
    if (prompting) return;
    prompting = true;
    try {
      const { response } = await dialog.showMessageBox(getParentWindow(), {
        type: 'warning',
        title: 'Update required',
        message: 'Your version is not supported.',
        detail: 'Study rooms need the latest version of Focuvibe. Relaunch to update.',
        buttons: ['Relaunch to Update', 'Not Now'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (response === 0) await requireUpdate();
    } finally {
      prompting = false;
    }
  }

  return { start, stop, requireUpdate, promptUnsupported };
}

/** The Store build: nothing to poll, and "update required" opens the Store's updates page. */
function createStoreUpdateManager({ getParentWindow, dialog, shell }) {
  let prompting = false;

  async function promptUnsupported() {
    if (prompting) return;
    prompting = true;
    try {
      const { response } = await dialog.showMessageBox(getParentWindow(), {
        type: 'warning',
        title: 'Update required',
        message: 'Your version is not supported.',
        detail: 'Study rooms need the latest version of Focuvibe. Update it from the Microsoft Store.',
        buttons: ['Open Microsoft Store', 'Not Now'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (response === 0) await shell.openExternal(STORE_UPDATES_URI);
    } finally {
      prompting = false;
    }
  }

  return {
    start() {},
    stop() {},
    requireUpdate: async () => 'store',
    promptUnsupported,
  };
}

module.exports = { createUpdateManager, CHECK_INTERVAL_MS, STORE_UPDATES_URI };

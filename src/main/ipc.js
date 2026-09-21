'use strict';

const { ipcMain, shell, app } = require('electron');

const store = require('./store');

/**
 * @param {object} deps
 * @param {import('./timer-source').TimerSource} deps.timer The live timer: personal or room.
 * @param {import('./window-manager').WindowManager} deps.windows
 * @param {() => object} deps.getSettings
 * @param {(settings: object) => object} deps.applySettings
 * @param {ReturnType<import('./global-stats').createGlobalStats>} deps.globalStats
 */
function registerIpc({ timer, windows, getSettings, applySettings, globalStats }) {
  ipcMain.handle('flowcus:bootstrap', () => ({
    state: timer.getState(),
    settings: getSettings(),
    stats: store.todayStats(),
    mini: windows.isMini,
    version: app.getVersion(),
    packaged: app.isPackaged,
  }));

  // The verb whitelist lives in timer-source.js: unknown verbs are ignored there.
  ipcMain.on('flowcus:action', (_event, message) => {
    if (!message || typeof message.type !== 'string') return;
    timer.dispatch(message.type, message.payload);
  });

  ipcMain.handle('flowcus:save-settings', (_event, raw) => {
    const settings = applySettings(raw);
    return settings;
  });

  ipcMain.handle('flowcus:window', (_event, action) => {
    const win = windows.win;
    if (!win || win.isDestroyed()) return null;

    switch (action) {
      case 'minimize':
        win.minimize();
        return windows.isMini;
      case 'close':
        win.close();
        return windows.isMini;
      case 'toggle-mini':
        return windows.toggleMini();
      case 'exit-mini':
        return windows.setMini(false);
      default:
        return windows.isMini;
    }
  });

  ipcMain.handle('flowcus:open-reward', (_event, url) => {
    // shell.openExternal will happily launch a local handler for schemes like
    // file: or a custom protocol, so only real web links get through.
    if (!store.isSafeUrl(url)) return false;
    shell.openExternal(String(url));
    return true;
  });

  ipcMain.handle('flowcus:stats', () => store.todayStats());
  ipcMain.handle('flowcus:analytics', () => store.analyticsSummary());

  /** Whitelisted read of the global aggregate; resolves null when unconfigured. */
  ipcMain.handle('flowcus:global-stats', () => globalStats.fetchGlobalMinutes());
}

module.exports = { registerIpc };

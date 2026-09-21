'use strict';

const path = require('node:path');
const { app, BrowserWindow, screen } = require('electron');

const { WINDOW } = require('./constants');

/** Gap from the screen edge when the mini widget first appears. */
const MINI_MARGIN = 24;

/**
 * Owns the single BrowserWindow and both of its shapes.
 *
 * Mini mode is the same window with different bounds plus a `mini` class on
 * the document, not a second window. One window means there is no cross-window
 * state to keep in sync and no second renderer to pay for.
 */
class WindowManager {
  constructor() {
    this.win = null;
    this.isMini = false;
    this.normalBounds = null;
    this.miniPosition = null;
  }

  create() {
    this.win = new BrowserWindow({
      width: WINDOW.normal.width,
      height: WINDOW.normal.height,
      minWidth: WINDOW.normal.minWidth,
      minHeight: WINDOW.normal.minHeight,
      // Frameless throughout, so switching to the mini widget is a resize
      // rather than a jarring change of chrome.
      frame: false,
      backgroundColor: '#0A0B0D',
      show: false,
      resizable: true,
      maximizable: false,
      fullscreenable: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // The clock lives in the main process, but the renderer still animates
        // and plays the alarm, so it must not be throttled when hidden.
        backgroundThrottling: false,
        // The wall-end tone and the break alarm both play with no recent user
        // gesture. This is Electron's default; it is pinned here because both
        // features silently break without it.
        autoplayPolicy: 'no-user-gesture-required',
      },
    });

    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

    this.win.once('ready-to-show', () => this.win.show());

    // Nothing in this app should ever open a second window.
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    // Surface renderer errors in the terminal during development; without this
    // a thrown exception in the renderer is invisible outside devtools.
    if (!app.isPackaged) {
      this.win.webContents.on('console-message', (...args) => {
        // Electron 36+ passes a single event object; older versions pass a list.
        const details = typeof args[0] === 'object' && args[0] !== null && 'message' in args[0]
          ? args[0]
          : { level: args[1], message: args[2], lineNumber: args[3], sourceId: args[4] };
        console.log(`[renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`);
      });

      this.win.webContents.on('preload-error', (_event, preloadPath, error) => {
        console.error(`[preload] ${preloadPath}:`, error);
      });
    }

    // Remember where the user parks each shape.
    this.win.on('moved', () => this.rememberBounds());
    this.win.on('resized', () => this.rememberBounds());

    return this.win;
  }

  rememberBounds() {
    if (!this.win || this.win.isDestroyed()) return;
    const bounds = this.win.getBounds();
    if (this.isMini) {
      this.miniPosition = { x: bounds.x, y: bounds.y };
    } else {
      this.normalBounds = bounds;
    }
  }

  /** Top-right corner of whichever display the window is currently on. */
  defaultMiniPosition() {
    const display = screen.getDisplayMatching(this.win.getBounds());
    const area = display.workArea;
    return {
      x: area.x + area.width - WINDOW.mini.width - MINI_MARGIN,
      y: area.y + MINI_MARGIN,
    };
  }

  setMini(enabled) {
    if (!this.win || this.win.isDestroyed()) return this.isMini;
    if (enabled === this.isMini) return this.isMini;

    if (enabled) {
      this.normalBounds = this.win.getBounds();

      // Order matters. Windows clamps a resize to the window's current minimum
      // size, so shrinking below the normal minimum silently does nothing
      // unless the minimum is lowered first. This is the single most common
      // reason a mini mode appears not to work.
      this.win.setResizable(false);
      this.win.setMinimumSize(WINDOW.mini.width, WINDOW.mini.height);

      const position = this.miniPosition || this.defaultMiniPosition();
      this.win.setBounds({
        x: position.x,
        y: position.y,
        width: WINDOW.mini.width,
        height: WINDOW.mini.height,
      });

      // 'screen-saver' is the highest level Electron exposes. Plain
      // setAlwaysOnTop(true) will not reliably float above a fullscreen editor.
      this.win.setAlwaysOnTop(true, 'screen-saver');
      this.win.setVisibleOnAllWorkspaces(true);
    } else {
      this.miniPosition = { x: this.win.getBounds().x, y: this.win.getBounds().y };

      this.win.setAlwaysOnTop(false);
      this.win.setVisibleOnAllWorkspaces(false);
      this.win.setMinimumSize(WINDOW.normal.minWidth, WINDOW.normal.minHeight);
      this.win.setResizable(true);

      const bounds = this.normalBounds || {
        width: WINDOW.normal.width,
        height: WINDOW.normal.height,
      };
      this.win.setBounds(bounds);
    }

    this.isMini = enabled;
    this.send('flowcus:mini', this.isMini);
    return this.isMini;
  }

  toggleMini() {
    return this.setMini(!this.isMini);
  }

  send(channel, payload) {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send(channel, payload);
  }

  focusExisting() {
    if (!this.win || this.win.isDestroyed()) return;
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.win.focus();
  }
}

module.exports = { WindowManager };

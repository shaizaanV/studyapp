'use strict';

const path = require('node:path');
const { app, powerMonitor, safeStorage } = require('electron');

const { APP_ID, PHASES, MODES } = require('./constants');
const store = require('./store');
const { TimerEngine, MINUTE_MS } = require('./timer-engine');
const { TimerSource } = require('./timer-source');
const { RoomTimer } = require('./room-timer');
const { RoomService } = require('./room-service');
const { createRoomAuth } = require('./room-auth');
const { createInviteCodec } = require('./room-invite');
const { createSecretFile } = require('./secret-file');
const { registerRoomIpc } = require('./room-ipc');
const { WindowManager } = require('./window-manager');
const { registerIpc } = require('./ipc');
const { createUpdateManager } = require('./update-manager');
const { createGlobalStats } = require('./global-stats');
const notifier = require('./notifier');

/**
 * Must be set before any notification is raised, and must match `appId` in
 * electron-builder.yml. Windows pairs toasts with the AppUserModelID stamped
 * on the Start Menu shortcut the installer writes; a mismatch means every
 * toast is dropped silently, with no error anywhere.
 */
app.setAppUserModelId(APP_ID);

// Lets the development screenshot harness run against a throwaway profile
// instead of the real settings and session history.
if (process.env.FLOWCUS_USER_DATA) {
  app.setPath('userData', process.env.FLOWCUS_USER_DATA);
}

// A second launch should surface the running timer, not start a rival clock.
// FLOWCUS_MULTI_INSTANCE lets two dev profiles (see FLOWCUS_USER_DATA) run side
// by side to try a study room on one machine.
if (!process.env.FLOWCUS_MULTI_INSTANCE) {
  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    app.quit();
  }
}

let settings = null;
/** The personal timer. Everything but the capture harness talks to `timer`. */
let engine = null;
/** The live timer: `engine`, or the study room's timer while a room is active. */
let timer = null;
let room = null;
let globalStats = null;
const windows = new WindowManager();

const formatMinutes = (ms) => { 
  const totalMinutes = ms / MINUTE_MS;
  const whole = Math.floor(totalMinutes);
  const seconds = Math.round((totalMinutes - whole) * 60);
  if (whole === 0) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  if (seconds === 0) return `${whole} minute${whole === 1 ? '' : 's'}`;
  return `${whole} min ${seconds} sec`;
};

function applySettings(raw) {
  settings = store.saveSettings(raw);
  timer.setSettings(settings);
  windows.send('flowcus:settings', settings);
  return settings;
}

function wireEngine() {
  timer.on('state', (state) => windows.send('flowcus:state', state));

  timer.on('session', (session) => {
    store.appendSession(session);
    windows.send('flowcus:stats', store.todayStats());

    // Anonymous, opt-out: only {anon_id, minutes_spent} ever leaves the
    // device (see global-stats.js). Never fired for a session with no
    // focus time, and never anything from a study room.
    if (settings.shareAnonymousStats && session.focusMs > 0) {
      globalStats.reportMinutes(session.focusMs / MINUTE_MS);
    }
  });

  // Focus period finished on its own (pomodoro only).
  timer.on('focus-complete', () => {
    notifier.notify({
      title: 'Focus complete',
      body: timer.inRoom
        ? 'Focus complete. Your break has started. Step away from the screen.'
        : `${settings.breakMin} minute break unlocked. Step away from the screen.`,
    });
    notifier.alertWindow(windows.win);
    windows.send('flowcus:chime');
  });

  // Wall Method baseline hit 0:00. The engine has already handed over to a
  // running focus period; this signals it and pulls the window forward.
  timer.on('wall-complete', () => {
    windows.send('flowcus:tone');
    notifier.forceFocus(windows.win, () => windows.isMini);
  });

  // Break countdown hit zero: this is the one that has to be impossible to ignore.
  timer.on('alarm', ({ breakMs }) => {
    notifier.notify({
      title: 'Break over',
      body: `Your ${formatMinutes(breakMs)} break is done. Phone away, back to it.`,
      // Keeps the toast on screen until dismissed instead of auto-hiding.
      scenario: 'alarm',
      silent: true,
    });
    notifier.alertWindow(windows.win);
    windows.send('flowcus:alarm', { playing: true, volume: settings.alarmVolume });
  });

  timer.on('alarm-stop', () => {
    notifier.clearAlert(windows.win, windows.isMini);
    windows.send('flowcus:alarm', { playing: false });
  });
}

function wirePower() {
  // Focus time did not happen while the laptop was asleep, so pause it. The
  // source ignores power events while a room is active: the host's clock rules
  // there, and one sleeping laptop must not pause everyone else.
  powerMonitor.on('suspend', () => timer.handleSuspend());
  powerMonitor.on('resume', () => timer.handleResume());

  // Locking the screen is a deliberate step away; treat it like a suspend.
  powerMonitor.on('lock-screen', () => timer.handleSuspend());
}

/**
 * Study rooms: the network and trust logic lives in RoomService, the renderer
 * only moves opaque strings over WebRTC. Joining a room swaps the live timer.
 */
function setUpRoom() {
  const userData = app.getPath('userData');
  const auth = createRoomAuth({
    secret: createSecretFile({ filePath: path.join(userData, 'flowcus-room-key.bin'), safeStorage }),
  });
  const roomTimer = new RoomTimer({ getSettings: () => settings });
  room = new RoomService({ auth, invites: createInviteCodec({ auth }), timer: roomTimer });

  room.on('joined', () => {
    // A personal session cannot run alongside a room. The invite flow refuses to
    // start while one is running; this catches one begun while waiting to be admitted.
    if (engine.getState().phase !== PHASES.IDLE) engine.resetAll(MODES.POMODORO);
    timer.useRoom(roomTimer);
  });
  room.on('left', () => timer.useLocal());

  registerRoomIpc({
    service: room,
    windows,
    turnSecret: createSecretFile({ filePath: path.join(userData, 'flowcus-room-turn.bin'), safeStorage }),
    localIsIdle: () => engine.getState().phase === PHASES.IDLE,
  });
  room.startTicking();
}

app.whenReady().then(() => {
  settings = store.loadSettings();
  engine = new TimerEngine(settings);
  timer = new TimerSource(engine);

  windows.create();

  globalStats = createGlobalStats({
    secret: createSecretFile({
      filePath: path.join(app.getPath('userData'), 'flowcus-stats-identity.bin'),
      safeStorage,
    }),
  });

  registerIpc({
    timer,
    windows,
    getSettings: () => settings,
    applySettings,
    globalStats,
  });

  wireEngine();
  wirePower();
  setUpRoom();
  timer.startTicking();

  createUpdateManager({ getParentWindow: () => windows.win }).start();

  if (process.env.FLOWCUS_CAPTURE) {
    // Development screenshot harness (npm run smoke). It lives outside src/ so
    // it is never packaged, and is only ever required when the env var is set.
    require('../../tools/capture').run({ app, engine, windows });
  }
});

app.on('second-instance', () => windows.focusExisting());

// Closing the window ends the app, and with it the room: leave() tells the
// other peers, so they need not wait out the 8 second silence.
app.on('window-all-closed', () => {
  room?.leave();
  room?.stopTicking();
  timer?.stopTicking();
  app.quit();
});

app.on('before-quit', () => {
  room?.leave();
  room?.stopTicking();
  timer?.stopTicking();
});

module.exports = { MODES, PHASES };

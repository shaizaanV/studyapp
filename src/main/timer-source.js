'use strict';

const { EventEmitter } = require('node:events');

/** Every timer verb a local session accepts, keyed by the name the renderer sends. */
const LOCAL_ACTIONS = {
  'set-mode': (engine, payload) => engine.setMode(payload),
  start: (engine) => engine.start(),
  pause: (engine) => engine.pause(),
  resume: (engine) => engine.resume(),
  stop: (engine) => engine.stop(),
  'start-break': (engine) => engine.startBreak(),
  'pause-break': (engine) => engine.pauseBreak(),
  'resume-break': (engine) => engine.resumeBreak(),
  'skip-break': (engine) => engine.skipBreak(),
  'dismiss-alarm': (engine) => engine.dismissAlarm(),
  'continue-session': (engine) => engine.continueSession(),
  'abandon-wall': (engine) => engine.abandonWall(),
};

/** Verbs a room timer understands; the rest (Flow mode, the wall) have no meaning in a room. */
const ROOM_ACTIONS = new Set([
  'start', 'pause', 'resume', 'stop',
  'pause-break', 'resume-break', 'skip-break',
  'dismiss-alarm', 'continue-session',
]);

/** Events every timer emits and the app reacts to. */
const EVENTS = ['state', 'session', 'wall-complete', 'focus-complete', 'alarm', 'alarm-stop'];

/**
 * The one timer the rest of the app talks to: a switch between the personal
 * TimerEngine and, while a study room is active, the RoomTimer.
 *
 * Callers use getState / dispatch / on and never learn which is live. Events
 * from the inactive timer are dropped, so a stale local tick cannot leak into
 * a room. Power events belong to the local timer only: a room's clock is the
 * host's, and a sleeping laptop must not pause everyone else.
 */
class TimerSource extends EventEmitter {
  constructor(localEngine) {
    super();
    this.local = localEngine;
    this.room = null;
    for (const name of EVENTS) {
      localEngine.on(name, (payload) => this.forward(localEngine, name, payload));
    }
  }

  get active() {
    return this.room || this.local;
  }

  get inRoom() {
    return this.room !== null;
  }

  forward(source, name, payload) {
    if (source === this.active) this.emit(name, payload);
  }

  /** Routes the app to a room timer. Its events are wired on first use. */
  useRoom(roomTimer) {
    if (this.room === roomTimer) return;
    if (!roomTimer.__wired) {
      for (const name of EVENTS) {
        roomTimer.on(name, (payload) => this.forward(roomTimer, name, payload));
      }
      roomTimer.__wired = true;
    }
    this.room = roomTimer;
    roomTimer.startTicking();
    this.emit('state', this.getState());
  }

  useLocal() {
    if (!this.room) return;
    this.room.stopTicking();
    this.room = null;
    this.emit('state', this.getState());
  }

  getState() {
    return this.active.getState();
  }

  /** Applies a renderer verb to whichever timer is live. Unknown verbs are ignored. */
  dispatch(type, payload) {
    if (this.room) {
      if (ROOM_ACTIONS.has(type)) this.room.dispatch(type);
      return;
    }
    const handler = LOCAL_ACTIONS[type];
    if (handler) handler(this.local, payload);
  }

  setSettings(settings) {
    this.local.setSettings(settings);
    if (this.room) this.room.setSettings(settings);
  }

  emitState() {
    this.active.emitState();
  }

  startTicking() {
    this.local.startTicking();
    if (this.room) this.room.startTicking();
  }

  stopTicking() {
    this.local.stopTicking();
    if (this.room) this.room.stopTicking();
  }

  handleSuspend() {
    if (!this.room) this.local.handleSuspend();
  }

  handleResume() {
    if (!this.room) this.local.handleResume();
  }
}

module.exports = { TimerSource, LOCAL_ACTIONS, ROOM_ACTIONS };

'use strict';

const { EventEmitter } = require('node:events');

const { TICK_MS, WALL_MS } = require('./constants');
const Clock = require('../shared/room-clock');

const MINUTE_MS = 60000;

/**
 * The room's timer, presented with the same surface TimerEngine has so the
 * rest of the app cannot tell the difference.
 *
 * As host it owns the shared state: it applies actions, advances phases and
 * emits 'broadcast' with every new state for RoomService to sign and send. As
 * follower it holds the host's latest state and computes what is left on its
 * own clock using `offsetMs` (hostClock - localClock). Both roles emit the
 * same 'state' / 'session' / 'focus-complete' / 'alarm' / 'alarm-stop' events
 * a TimerEngine does, derived from the phase transitions they observe.
 */
class RoomTimer extends EventEmitter {
  /** @param {{now?: () => number, getSettings: () => {focusMin:number, breakMin:number}}} deps */
  constructor({ now = Date.now, getSettings }) {
    super();
    this.now = now;
    this.getSettings = getSettings;
    this.interval = null;
    this.role = 'follower';
    this.offsetMs = 0;
    this.shared = null;
    this.alarmSilenced = false;
    this.reset();
  }

  // ---------------------------------------------------------------- lifecycle

  /** Forgets the room. The timer sits idle on this machine's own settings. */
  reset() {
    this.role = 'host';
    this.offsetMs = 0;
    this.alarmSilenced = false;
    this.shared = Clock.createIdle(this.durations());
  }

  durations() {
    const settings = this.getSettings();
    return { focusMs: settings.focusMin * MINUTE_MS, breakMs: settings.breakMin * MINUTE_MS };
  }

  /** Host time is this machine's time; a follower reads the host's clock through the offset. */
  hostNow() {
    return this.now() + this.offsetMs;
  }

  /**
   * Takes over as (or starts as) host. `hostSeq` fences out the previous host's
   * states. An inherited state has its end time moved onto this machine's clock.
   */
  becomeHost({ hostSeq, inherit = true }) {
    const previous = inherit ? this.shared : null;
    const shift = this.offsetMs;
    this.role = 'host';
    this.offsetMs = 0;
    const base = previous || Clock.createIdle(this.durations());
    const carried = { ...base, hostSeq, seq: base.seq + 1 };
    if (carried.endsAtEpochMs !== null && carried.endsAtEpochMs !== undefined) {
      carried.endsAtEpochMs -= shift;
    }
    this.shared = carried;
    this.emit('broadcast', this.shared);
    this.emitState();
  }

  becomeFollower({ offsetMs = 0 } = {}) {
    this.role = 'follower';
    this.offsetMs = offsetMs;
    this.alarmSilenced = false;
    this.shared = Clock.createIdle({ ...this.durations(), hostSeq: 0 });
    this.emitState();
  }

  setOffset(offsetMs) {
    if (this.role !== 'follower' || this.offsetMs === offsetMs) return;
    this.offsetMs = offsetMs;
    this.emitState();
  }

  /** A validated state from the host. Followers only; the caller has checked staleness. */
  applyRemote(state, offsetMs) {
    if (this.role !== 'follower') return;
    if (offsetMs !== undefined) this.offsetMs = offsetMs;
    this.transition(state);
  }

  setSettings() {
    if (this.role === 'host' && this.shared.phase === 'IDLE') {
      this.shared = { ...this.shared, ...this.durations(), seq: this.shared.seq + 1 };
      this.emit('broadcast', this.shared);
    }
    this.emitState();
  }

  startTicking() {
    if (this.interval) return;
    this.interval = setInterval(() => this.tick(), TICK_MS);
  }

  stopTicking() {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }

  // ----------------------------------------------------------------- actions

  /** Host verbs change the shared state. A follower can only silence its own alarm. */
  dispatch(type) {
    if (this.role !== 'host') {
      if (type === 'dismiss-alarm' && this.shared.phase === 'ALARM') {
        this.alarmSilenced = true;
        this.emit('alarm-stop');
      }
      return;
    }
    const now = this.now();
    const applied = Clock.applyAction(this.shared, type, now);
    if (!applied) return;
    this.transition(applied);
    this.emit('broadcast', this.shared);
  }

  tick() {
    if (this.role === 'host') {
      const advanced = Clock.tick(this.shared, this.now());
      if (advanced) {
        this.transition(advanced);
        this.emit('broadcast', this.shared);
        return;
      }
    }
    this.emitState();
  }

  /** Installs a new shared state and raises whatever the phase change means. */
  transition(state) {
    const previous = this.shared;
    this.shared = state;
    if (state.phase !== 'ALARM') this.alarmSilenced = false;
    for (const event of Clock.transitionEvents(previous, state, this.hostNow())) {
      if (event.name === 'alarm' && this.alarmSilenced) continue;
      this.emit(event.name, event.payload);
    }
    this.emitState();
  }

  // ------------------------------------------------------------ state payload

  /** The shared state exactly as it should be sent. Host only. */
  snapshot() {
    return this.shared;
  }

  /** Same shape as TimerEngine.getState(), plus `room` for the UI. */
  getState() {
    const s = this.shared;
    const hostNow = this.hostNow();
    const left = Clock.remaining(s, hostNow);
    const inFocus = s.phase === 'FOCUS' || s.phase === 'FOCUS_PAUSED';
    const inBreak = s.phase === 'BREAK' || s.phase === 'BREAK_PAUSED' || s.phase === 'ALARM';

    const focusRemainingMs = inFocus ? left : s.phase === 'IDLE' ? s.focusMs : 0;
    const focusMs = s.focusMs - focusRemainingMs;
    const breakRemainingMs = inBreak ? left : 0;

    let ring = { progress: 0, label: 'FOCUS' };
    if (inFocus) ring = { progress: s.focusMs > 0 ? focusMs / s.focusMs : 0, label: 'FOCUS' };
    if (inBreak) ring = { progress: s.breakMs > 0 ? 1 - breakRemainingMs / s.breakMs : 1, label: 'BREAK' };
    ring.progress = Math.min(1, Math.max(0, ring.progress));

    return {
      mode: 'POMODORO',
      phase: s.phase,
      focusMs,
      focusTargetMs: s.focusMs,
      focusRemainingMs,
      wallTotalMs: WALL_MS,
      wallRemainingMs: 0,
      wallInterrupted: false,
      breakTotalMs: inBreak ? s.breakMs : 0,
      breakRemainingMs,
      earned: null,
      earnedKind: inBreak ? 'FIXED' : null,
      pausedBySuspend: false,
      ring,
      room: { role: this.role },
    };
  }

  emitState() {
    this.emit('state', this.getState());
  }
}

module.exports = { RoomTimer };

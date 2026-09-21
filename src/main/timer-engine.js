'use strict';

const { EventEmitter } = require('node:events');

const { TICK_MS, MODES, PHASES, WALL_MS } = require('./constants');
const { computeBreak } = require('./flowcus-algorithm');

const MINUTE_MS = 60000;

/** A flow session shorter than this is treated as a false start, not a session. */
const MIN_FLOW_SESSION_MS = 60000;

/**
 * The most focus time a late tick at the wall boundary may credit. A normal
 * tick is at most TICK_MS late; anything beyond this means the process was
 * stalled or a suspend event was missed, and that time was not work.
 */
const MAX_BOUNDARY_CATCH_UP_MS = TICK_MS * 4;

/**
 * The single source of truth for time in Flowcus.
 *
 * This deliberately lives in the main process. Chromium throttles renderer
 * timers hard once a window is minimised, hidden or backgrounded -- intervals
 * get clamped to a second or worse -- which would quietly destroy a timer app.
 *
 * Elapsed time is always derived from wall-clock deltas rather than by
 * incrementing a counter each tick, so a late, early or entirely missed tick
 * cannot accumulate drift. The tick only samples the clock and looks for
 * threshold crossings.
 *
 * Phases:
 *
 *   IDLE -> [WALL] -> FOCUS <-> FOCUS_PAUSED -> BREAK_PENDING -> BREAK <-> BREAK_PAUSED -> ALARM
 *
 * Every break phase (BREAK_PENDING, BREAK, BREAK_PAUSED, ALARM) has two exits:
 * continueSession() loops back to FOCUS without ending anything, endSession()
 * returns to IDLE.
 *
 * WALL is the optional Wall Method baseline. It is structurally outside the
 * focus phases: its time is tracked on its own timestamp and never touches
 * the focus accumulator, so it cannot reach the tier engine or earn a break.
 */
class TimerEngine extends EventEmitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.interval = null;
    this.resetAll(MODES.POMODORO);
  }

  // ---------------------------------------------------------------- lifecycle

  startTicking() {
    if (this.interval) return;
    this.interval = setInterval(() => this.tick(), TICK_MS);
    // The interval stays referenced on purpose: unref-ing it would let the
    // process exit out from under a running session.
  }

  stopTicking() {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }

  setSettings(settings) {
    this.settings = settings;
    // Re-arm an idle pomodoro so a duration change is visible immediately.
    // Toggling the Wall Method mid-wall leaves the running wall alone; the
    // change applies from the next Start.
    if (this.phase === PHASES.IDLE) {
      this.pomodoroTargetMs = settings.focusMin * MINUTE_MS;
    }
    this.emitState();
  }

  resetAll(mode = this.mode) {
    this.mode = mode;
    this.phase = PHASES.IDLE;

    this.wallStartedAt = null;
    this.wallInterrupted = false;

    this.focusAccumMs = 0;
    this.focusSegmentStart = null;
    this.pomodoroTargetMs = this.settings.focusMin * MINUTE_MS;

    // How much of focusAccumMs has already been written to session history.
    // Kept in lockstep with focusAccumMs -- reset here and in beginFocus(),
    // advanced in commitBreak() -- so continuing a session past a break logs
    // only the newly-done time instead of re-logging what came before it.
    this.loggedFocusMs = 0;

    this.earned = null;
    this.earnedKind = null;
    this.breakTotalMs = 0;
    this.breakAccumMs = 0;
    this.breakSegmentStart = null;

    this.pausedBySuspend = false;
  }

  // ----------------------------------------------------------------- derived

  wallElapsedMs() {
    if (this.phase !== PHASES.WALL || this.wallStartedAt === null) return 0;
    return Math.max(0, Date.now() - this.wallStartedAt);
  }

  wallRemainingMs() {
    if (this.phase !== PHASES.WALL) return 0;
    return Math.max(0, WALL_MS - this.wallElapsedMs());
  }

  focusElapsedMs() {
    const running = this.phase === PHASES.FOCUS && this.focusSegmentStart !== null;
    const live = running ? Date.now() - this.focusSegmentStart : 0;
    return this.focusAccumMs + Math.max(0, live);
  }

  breakElapsedMs() {
    const running = this.phase === PHASES.BREAK && this.breakSegmentStart !== null;
    const live = running ? Date.now() - this.breakSegmentStart : 0;
    return this.breakAccumMs + Math.max(0, live);
  }

  breakRemainingMs() {
    return Math.max(0, this.breakTotalMs - this.breakElapsedMs());
  }

  /** WALL is deliberately not a focus phase -- that is what exempts it from the tiers. */
  isFocusPhase() {
    return this.phase === PHASES.FOCUS || this.phase === PHASES.FOCUS_PAUSED;
  }

  isBreakPhase() {
    return (
      this.phase === PHASES.BREAK ||
      this.phase === PHASES.BREAK_PAUSED ||
      this.phase === PHASES.BREAK_PENDING ||
      this.phase === PHASES.ALARM
    );
  }

  // ----------------------------------------------------------- focus actions

  setMode(mode) {
    if (!MODES[mode] || mode === this.mode) return;
    // Switching modes mid-session would make the elapsed time meaningless, so
    // it is only offered while idle; the UI hides the switch once running.
    if (this.phase !== PHASES.IDLE) return;
    this.resetAll(mode);
    this.emitState();
  }

  /** Start either goes straight to focus, or through the Wall Method first. */
  start() {
    if (this.phase !== PHASES.IDLE) return;
    this.wallInterrupted = false;
    if (this.settings.wallMethodEnabled) {
      this.beginWall();
      return;
    }
    this.beginFocus(Date.now());
  }

  beginWall() {
    this.wallStartedAt = Date.now();
    this.phase = PHASES.WALL;
    this.emitState();
  }

  /**
   * Opens a focus period whose clock began at `startedAt`. Taking the start
   * time as an argument is what lets the wall hand over at its exact boundary.
   */
  beginFocus(startedAt) {
    this.focusAccumMs = 0;
    this.loggedFocusMs = 0;
    this.focusSegmentStart = startedAt;
    this.pomodoroTargetMs = this.settings.focusMin * MINUTE_MS;
    this.phase = PHASES.FOCUS;
    this.emitState();
  }

  /** The wall hit 0:00: hand straight over to a running focus period. */
  completeWall() {
    const boundary = this.wallStartedAt + WALL_MS;
    // Focus begins at the instant the wall ended rather than whenever the tick
    // noticed, so the handover is drift-free. The clamp caps what a badly late
    // tick can credit as focus time.
    const startedAt = Math.max(boundary, Date.now() - MAX_BOUNDARY_CATCH_UP_MS);
    this.wallStartedAt = null;
    this.beginFocus(startedAt);
    this.emit('wall-complete', { mode: this.mode });
  }

  /**
   * The wall has no pause and no skip -- a strict baseline is ten unbroken
   * minutes -- but it can always be abandoned back to idle.
   */
  abandonWall() {
    if (this.phase !== PHASES.WALL) return;
    this.resetAll();
    this.emitState();
  }

  pause() {
    if (this.phase !== PHASES.FOCUS) return;
    this.focusAccumMs = this.focusElapsedMs();
    this.focusSegmentStart = null;
    this.phase = PHASES.FOCUS_PAUSED;
    // In flow mode the earned-break figure in the payload is recomputed every
    // tick, so pausing has already "instantly calculated" the current total.
    this.emitState();
  }

  resume() {
    if (this.phase !== PHASES.FOCUS_PAUSED) return;
    this.focusSegmentStart = Date.now();
    this.phase = PHASES.FOCUS;
    this.pausedBySuspend = false;
    this.emitState();
  }

  /**
   * Ends the focus period on purpose. In flow mode this is what commits the
   * earned break; in pomodoro mode it abandons the session.
   */
  stop() {
    if (!this.isFocusPhase()) return;

    this.focusAccumMs = this.focusElapsedMs();
    this.focusSegmentStart = null;
    const focusMs = this.focusAccumMs;

    if (this.mode === MODES.FLOW) {
      if (focusMs < MIN_FLOW_SESSION_MS) {
        // Too short to have earned anything; treat it as a false start.
        this.resetAll();
        this.emitState();
        return;
      }
      this.commitBreak(computeBreak(focusMs / MINUTE_MS), 'FLOW', focusMs, 'stop');
      return;
    }

    // A pomodoro stopped early earns no break -- the commitment is the point.
    this.emit('session', {
      mode: this.mode,
      focusMs,
      earnedMs: 0,
      endedAt: Date.now(),
      endReason: 'stop',
    });
    this.resetAll();
    this.emitState();
  }

  /** Pomodoro focus ran all the way down. */
  completeFocus() {
    this.focusAccumMs = this.pomodoroTargetMs;
    this.focusSegmentStart = null;
    this.commitBreak(null, 'FIXED', this.pomodoroTargetMs, 'complete');
    this.emit('focus-complete', { mode: this.mode });
  }

  /**
   * Moves into the break screen with a break of a known length.
   * @param {object|null} breakdown Tier breakdown for flow mode, null for pomodoro.
   * @param {'FLOW'|'FIXED'} kind
   * @param {number} focusMs
   * @param {'stop'|'complete'} endReason How the focus period ended, for analytics.
   */
  commitBreak(breakdown, kind, focusMs, endReason) {
    this.earned = breakdown;
    this.earnedKind = kind;
    this.breakTotalMs = kind === 'FLOW' ? breakdown.totalMs : this.settings.breakMin * MINUTE_MS;
    this.breakAccumMs = 0;
    this.breakSegmentStart = null;
    this.phase = PHASES.BREAK_PENDING;

    // Continuing past an earlier break (see continueSession()) keeps
    // accumulating on the same focusAccumMs, so focusMs here can include time
    // already logged at that earlier break. Log only the new portion so
    // continuing never double-counts history/analytics.
    const incrementMs = Math.max(0, focusMs - this.loggedFocusMs);
    this.loggedFocusMs = focusMs;

    this.emit('session', {
      mode: this.mode,
      focusMs: incrementMs,
      earnedMs: this.breakTotalMs,
      endedAt: Date.now(),
      endReason,
    });

    if (this.settings.autoStartBreak) {
      this.startBreak();
    } else {
      this.emitState();
    }
  }

  // ----------------------------------------------------------- break actions

  startBreak() {
    if (this.phase !== PHASES.BREAK_PENDING) return;
    if (this.breakTotalMs <= 0) {
      this.resetAll();
      this.emitState();
      return;
    }
    this.breakSegmentStart = Date.now();
    this.phase = PHASES.BREAK;
    this.emitState();
  }

  pauseBreak() {
    if (this.phase !== PHASES.BREAK) return;
    this.breakAccumMs = this.breakElapsedMs();
    this.breakSegmentStart = null;
    this.phase = PHASES.BREAK_PAUSED;
    this.emitState();
  }

  resumeBreak() {
    if (this.phase !== PHASES.BREAK_PAUSED) return;
    this.breakSegmentStart = Date.now();
    this.phase = PHASES.BREAK;
    this.emitState();
  }

  skipBreak() {
    if (!this.isBreakPhase()) return;
    const wasAlarming = this.phase === PHASES.ALARM;
    this.resetAll();
    if (wasAlarming) this.emit('alarm-stop');
    this.emitState();
  }

  /** Break countdown reached zero. */
  triggerAlarm() {
    this.breakAccumMs = this.breakTotalMs;
    this.breakSegmentStart = null;
    this.phase = PHASES.ALARM;
    this.emit('alarm', { breakMs: this.breakTotalMs });
    this.emitState();
  }

  dismissAlarm() {
    if (this.phase !== PHASES.ALARM) return;
    this.resetAll();
    this.emit('alarm-stop');
    this.emitState();
  }

  /**
   * The other way out of a ringing alarm: keep the session going instead of
   * ending it. Flow leaves focusAccumMs untouched, so tier progress keeps
   * building on the work already done rather than resetting to zero for the
   * next break's calculation. Pomodoro starts a fresh focus period via
   * beginFocus(), since its target was already reached to get here.
   */
  continueSession() {
    if (this.phase !== PHASES.ALARM) return;

    this.breakTotalMs = 0;
    this.breakAccumMs = 0;
    this.breakSegmentStart = null;
    this.earned = null;
    this.earnedKind = null;

    if (this.mode === MODES.POMODORO) {
      this.beginFocus(Date.now()); // also emits state
    } else {
      this.focusSegmentStart = Date.now();
      this.phase = PHASES.FOCUS;
      this.emitState();
    }

    this.emit('alarm-stop');
  }

  // ------------------------------------------------------------ power events

  /**
   * The machine went to sleep or the screen was locked.
   *
   * Focus time did not happen while suspended, so it pauses. A wall baseline
   * interrupted this way was not ten unbroken minutes, so it starts over rather
   * than resuming. A running break is left alone on purpose: that break time
   * really did elapse in the world, which is exactly what a break is for.
   */
  handleSuspend() {
    if (this.phase === PHASES.FOCUS) {
      this.pause();
      this.pausedBySuspend = true;
      return;
    }
    if (this.phase === PHASES.WALL) {
      this.resetAll();
      this.wallInterrupted = true;
      this.emitState();
    }
  }

  handleResume() {
    // A break that expired mid-sleep is caught by the next tick.
    this.emitState();
  }

  // ------------------------------------------------------------------- tick

  tick() {
    if (this.phase === PHASES.WALL) {
      if (this.wallRemainingMs() <= 0) {
        this.completeWall();
      } else {
        this.emitState();
      }
      return;
    }

    if (this.phase === PHASES.FOCUS && this.mode === MODES.POMODORO) {
      if (this.focusElapsedMs() >= this.pomodoroTargetMs) {
        this.completeFocus();
        return;
      }
    }

    if (this.phase === PHASES.BREAK && this.breakRemainingMs() <= 0) {
      this.triggerAlarm();
      return;
    }

    this.emitState();
  }

  // ----------------------------------------------------------- state payload

  /**
   * Describes the progress ring. The wall fills toward its ten minutes;
   * pomodoro fills toward the end of the session; flow fills toward the next
   * tier boundary, so the ring still communicates progress while counting up.
   */
  ringState(focusMs) {
    if (this.phase === PHASES.WALL) {
      return { progress: Math.min(1, this.wallElapsedMs() / WALL_MS), label: 'WALL' };
    }

    if (this.isBreakPhase()) {
      const progress = this.breakTotalMs > 0 ? this.breakElapsedMs() / this.breakTotalMs : 0;
      return { progress: Math.min(1, Math.max(0, progress)), label: 'BREAK' };
    }

    if (this.mode === MODES.POMODORO) {
      const progress = this.pomodoroTargetMs > 0 ? focusMs / this.pomodoroTargetMs : 0;
      return { progress: Math.min(1, Math.max(0, progress)), label: 'FOCUS' };
    }

    const minutes = focusMs / MINUTE_MS;
    let from;
    let to;
    let tier;
    if (minutes < 60) {
      from = 0;
      to = 60;
      tier = 1;
    } else if (minutes < 90) {
      from = 60;
      to = 90;
      tier = 2;
    } else {
      // Past 90 minutes the ring cycles every 30 minutes so it keeps moving.
      const blocks = Math.floor((minutes - 90) / 30);
      from = 90 + blocks * 30;
      to = 120 + blocks * 30;
      tier = 3;
    }
    return {
      progress: Math.min(1, Math.max(0, (minutes - from) / (to - from))),
      label: 'TIER ' + tier,
    };
  }

  getState() {
    const focusMs = this.focusElapsedMs();

    // In flow mode the breakdown is recomputed continuously so the preview on
    // screen is never stale -- pausing or stopping just freezes what is shown.
    // isFocusPhase() excludes WALL, so the wall always previews zero.
    const liveEarned =
      this.mode === MODES.FLOW && this.isFocusPhase() ? computeBreak(focusMs / MINUTE_MS) : null;

    let earnedKind = null;
    if (this.earned) {
      earnedKind = this.earnedKind;
    } else if (liveEarned) {
      earnedKind = 'FLOW_PREVIEW';
    }

    return {
      mode: this.mode,
      phase: this.phase,
      focusMs,
      focusTargetMs: this.mode === MODES.POMODORO ? this.pomodoroTargetMs : null,
      focusRemainingMs:
        this.mode === MODES.POMODORO ? Math.max(0, this.pomodoroTargetMs - focusMs) : null,
      wallTotalMs: WALL_MS,
      wallRemainingMs: this.wallRemainingMs(),
      wallInterrupted: this.wallInterrupted,
      breakTotalMs: this.breakTotalMs,
      breakRemainingMs: this.breakRemainingMs(),
      earned: this.earned || liveEarned,
      earnedKind,
      pausedBySuspend: this.pausedBySuspend,
      ring: this.ringState(focusMs),
    };
  }

  emitState() {
    this.emit('state', this.getState());
  }
}

module.exports = { TimerEngine, MINUTE_MS, MAX_BOUNDARY_CATCH_UP_MS };

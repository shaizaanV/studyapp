'use strict';

/**
 * The shared Pomodoro state machine, as pure functions over the wire-format
 * timer state {phase, endsAtEpochMs, remainingMs, focusMs, breakMs, hostSeq, seq}.
 *
 * Only the host applies actions and expiry; everyone else just displays what
 * the host publishes. Times are absolute epoch milliseconds on the host's
 * clock, so a peer computes what is left instead of counting ticks.
 *
 * Rooms run a simplified cycle: IDLE -> FOCUS <-> FOCUS_PAUSED -> BREAK <->
 * BREAK_PAUSED -> ALARM -> (FOCUS | IDLE). The break starts by itself when
 * focus ends: there is no earned-break screen to dismiss in a shared room.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RoomClock = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const FOCUS_PHASES = ['FOCUS', 'FOCUS_PAUSED'];
  const BREAK_PHASES = ['BREAK', 'BREAK_PAUSED'];

  function createIdle({ focusMs, breakMs, hostSeq = 0, seq = 0 }) {
    return { phase: 'IDLE', endsAtEpochMs: null, remainingMs: null, focusMs, breakMs, hostSeq, seq };
  }

  const next = (state, fields) => ({ ...state, endsAtEpochMs: null, remainingMs: null, ...fields, seq: state.seq + 1 });

  /** Milliseconds left on the running or paused phase, in the state's own clock. */
  function remaining(state, now) {
    if (state.phase === 'FOCUS' || state.phase === 'BREAK') return Math.max(0, state.endsAtEpochMs - now);
    if (state.phase === 'FOCUS_PAUSED' || state.phase === 'BREAK_PAUSED') return state.remainingMs;
    return 0;
  }

  const startFocus = (state, now) => next(state, { phase: 'FOCUS', endsAtEpochMs: now + state.focusMs });

  /**
   * Applies a host action. Returns the next state, or null when the action is
   * not valid in the current phase (the caller then ignores it).
   */
  function applyAction(state, action, now) {
    switch (action) {
      case 'start':
        return state.phase === 'IDLE' ? startFocus(state, now) : null;
      case 'pause':
        return state.phase === 'FOCUS'
          ? next(state, { phase: 'FOCUS_PAUSED', remainingMs: remaining(state, now) })
          : null;
      case 'resume':
        return state.phase === 'FOCUS_PAUSED'
          ? next(state, { phase: 'FOCUS', endsAtEpochMs: now + state.remainingMs })
          : null;
      case 'stop':
        return FOCUS_PHASES.includes(state.phase) ? next(state, { phase: 'IDLE' }) : null;
      case 'pause-break':
        return state.phase === 'BREAK'
          ? next(state, { phase: 'BREAK_PAUSED', remainingMs: remaining(state, now) })
          : null;
      case 'resume-break':
        return state.phase === 'BREAK_PAUSED'
          ? next(state, { phase: 'BREAK', endsAtEpochMs: now + state.remainingMs })
          : null;
      case 'skip-break':
        return BREAK_PHASES.includes(state.phase) || state.phase === 'ALARM' ? next(state, { phase: 'IDLE' }) : null;
      case 'dismiss-alarm':
        return state.phase === 'ALARM' ? next(state, { phase: 'IDLE' }) : null;
      case 'continue-session':
        return state.phase === 'ALARM' ? startFocus(state, now) : null;
      default:
        return null;
    }
  }

  /**
   * Advances a running phase whose time has run out. Each hand-over starts at
   * the exact boundary instant rather than at `now`, so a late tick cannot
   * stretch a period. Returns the new state, or null if nothing expired.
   */
  function expire(state, now) {
    if (state.phase === 'FOCUS' && now >= state.endsAtEpochMs) {
      return next(state, { phase: 'BREAK', endsAtEpochMs: state.endsAtEpochMs + state.breakMs });
    }
    if (state.phase === 'BREAK' && now >= state.endsAtEpochMs) {
      return next(state, { phase: 'ALARM' });
    }
    return null;
  }

  /** Runs expiry to a fixpoint, so a long stall lands on the correct phase. */
  function tick(state, now) {
    let current = state;
    let changed = false;
    for (let i = 0; i < 4; i++) {
      const advanced = expire(current, now);
      if (!advanced) break;
      current = advanced;
      changed = true;
    }
    return changed ? current : null;
  }

  /**
   * What a transition means for a peer, as events named like TimerEngine's so
   * the rest of the app treats a room like a local session. Every peer runs
   * this on the states it sees, so each one records its own history.
   */
  function transitionEvents(prev, current, now) {
    const events = [];
    if (!prev || prev.phase === current.phase) return events;

    if (FOCUS_PHASES.includes(prev.phase) && current.phase === 'BREAK') {
      events.push({
        name: 'session',
        payload: {
          mode: 'POMODORO',
          focusMs: prev.focusMs,
          earnedMs: prev.breakMs,
          endedAt: now,
          endReason: 'complete',
          room: true,
        },
      });
      events.push({ name: 'focus-complete', payload: { mode: 'POMODORO' } });
    } else if (FOCUS_PHASES.includes(prev.phase) && current.phase === 'IDLE') {
      const elapsed = Math.max(0, prev.focusMs - remaining(prev, prev.phase === 'FOCUS' ? now : 0));
      if (elapsed > 0) {
        events.push({
          name: 'session',
          payload: { mode: 'POMODORO', focusMs: elapsed, earnedMs: 0, endedAt: now, endReason: 'stop', room: true },
        });
      }
    }

    if (BREAK_PHASES.includes(prev.phase) && current.phase === 'ALARM') {
      events.push({ name: 'alarm', payload: { breakMs: prev.breakMs } });
    }
    if (prev.phase === 'ALARM') events.push({ name: 'alarm-stop', payload: undefined });
    return events;
  }

  return { createIdle, remaining, applyAction, expire, tick, transitionEvents };
});

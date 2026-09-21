'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { TimerEngine, MAX_BOUNDARY_CATCH_UP_MS } = require('../src/main/timer-engine');
const { DEFAULT_SETTINGS, WALL_MS } = require('../src/main/constants');

const MIN = 60000;

/**
 * Drives the engine on a fake clock. The engine reads only Date.now(), so
 * replacing it gives full control over time; tick() is called by hand instead
 * of from the real interval.
 */
function harness(t, overrides = {}) {
  const realNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  t.after(() => {
    Date.now = realNow;
  });

  const engine = new TimerEngine({ ...DEFAULT_SETTINGS, ...overrides });
  const events = [];
  for (const name of ['session', 'wall-complete', 'focus-complete', 'alarm', 'alarm-stop']) {
    engine.on(name, (payload) => events.push({ name, payload }));
  }

  return {
    engine,
    events,
    named: (name) => events.filter((e) => e.name === name),
    /** Moves the clock forward and lets the engine observe it, like a real tick. */
    advance(ms) {
      now += ms;
      engine.tick();
    },
  };
}

test('without the Wall Method, Start goes straight to focus', (t) => {
  const h = harness(t);
  h.engine.start();
  assert.equal(h.engine.phase, 'FOCUS');
});

test('with the Wall Method, Start opens the wall instead of focus', (t) => {
  const h = harness(t, { wallMethodEnabled: true });
  h.engine.start();

  const state = h.engine.getState();
  assert.equal(state.phase, 'WALL');
  assert.equal(state.wallRemainingMs, WALL_MS);
  assert.equal(state.focusMs, 0);
});

test('the wall holds until exactly 10:00, then hands over once', (t) => {
  const h = harness(t, { wallMethodEnabled: true });
  h.engine.start();

  h.advance(WALL_MS - 1);
  assert.equal(h.engine.phase, 'WALL', 'still walling 1ms before the end');
  assert.equal(h.engine.getState().wallRemainingMs, 1);
  assert.equal(h.engine.getState().focusMs, 0, 'no focus accrues during the wall');

  h.advance(1);
  assert.equal(h.engine.phase, 'FOCUS', 'running focus at 0:00, with no extra click');
  assert.equal(h.named('wall-complete').length, 1);

  h.advance(MIN);
  assert.equal(h.named('wall-complete').length, 1, 'wall-complete fires exactly once');
});

test('flow: the ten wall minutes are exempt from the tiers', (t) => {
  const h = harness(t, { wallMethodEnabled: true });
  h.engine.setMode('FLOW');
  h.engine.start();

  h.advance(WALL_MS);
  // One hour of real flow after the wall.
  for (let i = 0; i < 60; i++) h.advance(MIN);

  const state = h.engine.getState();
  assert.equal(state.focusMs, 60 * MIN, 'only post-wall time is focus');
  // Had the wall counted, 70 min would earn 15 + 10 x 0.4 = 19.
  assert.equal(state.earned.totalMinutes, 15, '60 min of flow earns exactly Tier 1');

  h.engine.stop();
  const [session] = h.named('session');
  assert.equal(session.payload.focusMs, 60 * MIN, 'recorded session excludes the wall');
  assert.equal(h.engine.breakTotalMs, 15 * MIN);
});

test('flow: the wall itself previews zero break', (t) => {
  const h = harness(t, { wallMethodEnabled: true });
  h.engine.setMode('FLOW');
  h.engine.start();
  h.advance(5 * MIN);

  assert.equal(h.engine.getState().earned, null);
});

test('pomodoro: the wall does not eat into the focus period', (t) => {
  const h = harness(t, { wallMethodEnabled: true });
  h.engine.start();
  h.advance(WALL_MS);

  assert.equal(h.engine.getState().focusRemainingMs, DEFAULT_SETTINGS.focusMin * MIN);
});

test('handover is drift-free: focus starts at the boundary, not the tick', (t) => {
  const h = harness(t, { wallMethodEnabled: true });
  h.engine.start();

  // A normally late tick, 200ms past the boundary.
  h.advance(WALL_MS + 200);
  assert.equal(h.engine.phase, 'FOCUS');
  assert.equal(h.engine.getState().focusMs, 200, 'the 200ms after 0:00 is kept');
});

test('a badly late tick cannot credit the stall as focus', (t) => {
  const h = harness(t, { wallMethodEnabled: true });
  h.engine.start();

  // The process stalled for 30 seconds past the boundary.
  h.advance(WALL_MS + 30000);
  assert.equal(h.engine.phase, 'FOCUS');
  assert.ok(
    h.engine.getState().focusMs <= MAX_BOUNDARY_CATCH_UP_MS,
    `credited ${h.engine.getState().focusMs}ms, cap is ${MAX_BOUNDARY_CATCH_UP_MS}ms`
  );
});

test('the wall can be abandoned, but not paused, stopped or re-moded', (t) => {
  const h = harness(t, { wallMethodEnabled: true });
  h.engine.start();

  h.engine.pause();
  h.engine.stop();
  h.engine.setMode('FLOW');
  assert.equal(h.engine.phase, 'WALL', 'pause/stop/setMode are ignored');
  assert.equal(h.engine.mode, 'POMODORO');

  h.engine.abandonWall();
  assert.equal(h.engine.phase, 'IDLE');
  assert.equal(h.named('session').length, 0, 'an abandoned wall logs no session');
  assert.equal(h.named('wall-complete').length, 0);
});

test('sleep or lock during the wall restarts it rather than resuming', (t) => {
  const h = harness(t, { wallMethodEnabled: true });
  h.engine.start();
  h.advance(4 * MIN);

  h.engine.handleSuspend();
  assert.equal(h.engine.phase, 'IDLE');
  assert.equal(h.engine.getState().wallInterrupted, true);

  h.engine.start();
  assert.equal(h.engine.phase, 'WALL');
  assert.equal(h.engine.getState().wallRemainingMs, WALL_MS, 'a fresh full ten minutes');
  assert.equal(h.engine.getState().wallInterrupted, false, 'the notice clears on restart');
});

test('sessions record how they ended, for the stop-duration average', (t) => {
  const h = harness(t, { focusMin: 1 });

  h.engine.start();
  h.advance(MIN);
  assert.equal(h.named('session').at(-1).payload.endReason, 'complete', 'pomodoro ran down');
  h.engine.skipBreak();

  h.engine.start();
  h.advance(20000);
  h.engine.stop();
  assert.equal(h.named('session').at(-1).payload.endReason, 'stop', 'pomodoro stopped early');

  h.engine.setMode('FLOW');
  h.engine.start();
  h.advance(5 * MIN);
  h.engine.stop();
  assert.equal(h.named('session').at(-1).payload.endReason, 'stop', 'flow stopped');
});

test('the ring tracks the wall toward its ten minutes', (t) => {
  const h = harness(t, { wallMethodEnabled: true });
  h.engine.start();
  h.advance(WALL_MS / 4);

  const { ring } = h.engine.getState();
  assert.equal(ring.label, 'WALL');
  assert.equal(ring.progress, 0.25);
});

test('continueSession only fires from a ringing alarm', (t) => {
  const h = harness(t);
  h.engine.continueSession();
  assert.equal(h.engine.phase, 'IDLE', 'no-op when nothing is ringing');
});

test('flow: continuing past an alarm keeps tier progress instead of resetting it', (t) => {
  const h = harness(t);
  h.engine.setMode('FLOW');
  h.engine.start();
  h.advance(70 * MIN); // past the 60min tier-1/tier-2 boundary
  h.engine.stop();
  h.engine.startBreak();
  h.advance(h.engine.breakTotalMs);
  assert.equal(h.engine.phase, 'ALARM');

  h.engine.continueSession();
  assert.equal(h.engine.phase, 'FOCUS', 'back to a running focus period');
  assert.equal(h.named('alarm-stop').length, 1, 'the siren/toast are cleared');

  // Tier math is driven off the total accumulated focus time, so it should
  // read as if the 70 minutes already done never reset to zero.
  const state = h.engine.getState();
  assert.equal(state.focusMs, 70 * MIN, 'accumulated focus carried over the break');
  assert.equal(state.earned.totalMinutes, 19, '70min is already worth 15 + 10x0.4 of break');

  h.advance(20 * MIN); // 90 min total now
  h.engine.stop();
  const final = h.named('session').at(-1);
  assert.equal(final.payload.focusMs, 20 * MIN, 'only the new 20min is logged, not all 90');
  assert.equal(h.engine.earned.totalMinutes, 27, 'break is computed off the full 90min total');
});

test('pomodoro: continuing past an alarm starts a fresh focus period', (t) => {
  const h = harness(t, { focusMin: 1, breakMin: 1 });
  h.engine.start();
  h.advance(MIN); // focus completes on its own
  h.engine.startBreak();
  h.advance(MIN); // break completes on its own -> alarm
  assert.equal(h.engine.phase, 'ALARM');

  h.engine.continueSession();
  assert.equal(h.engine.phase, 'FOCUS');
  assert.equal(h.engine.getState().focusMs, 0, 'a brand new pomodoro period, not the finished one');

  // Confirms the reset target actually holds -- a stale target would
  // re-trigger completeFocus() on the very next tick.
  h.advance(MIN - 1);
  assert.equal(h.engine.phase, 'FOCUS');
  h.advance(1);
  assert.equal(h.engine.phase, 'BREAK_PENDING', 'the new period completes normally');

  const sessions = h.named('session');
  assert.equal(sessions.length, 2, 'each pomodoro period is its own history entry');
  assert.equal(sessions[0].payload.focusMs, MIN);
  assert.equal(sessions[1].payload.focusMs, MIN, 'not doubled up with the first period');
});

test('dismissing an alarm (End Session) still ends the session outright', (t) => {
  const h = harness(t);
  h.engine.setMode('FLOW');
  h.engine.start();
  h.advance(65 * MIN);
  h.engine.stop();
  h.engine.startBreak();
  h.advance(h.engine.breakTotalMs);

  h.engine.dismissAlarm();
  assert.equal(h.engine.phase, 'IDLE');
  assert.equal(h.named('alarm-stop').length, 1);
});

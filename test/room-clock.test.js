'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const C = require('../src/shared/room-clock');

const MIN = 60000;
const idle = () => C.createIdle({ focusMs: 25 * MIN, breakMs: 5 * MIN, hostSeq: 1 });
const T0 = 1_000_000;

test('start opens a focus period ending at now + focus length', () => {
  const s = C.applyAction(idle(), 'start', T0);
  assert.equal(s.phase, 'FOCUS');
  assert.equal(s.endsAtEpochMs, T0 + 25 * MIN);
  assert.equal(s.seq, 1);
});

test('actions invalid for the phase are refused', () => {
  assert.equal(C.applyAction(idle(), 'pause', T0), null);
  assert.equal(C.applyAction(idle(), 'resume', T0), null);
  assert.equal(C.applyAction(idle(), 'stop', T0), null);
  assert.equal(C.applyAction(idle(), 'dismiss-alarm', T0), null);
  assert.equal(C.applyAction(idle(), 'set-mode', T0), null);
  const running = C.applyAction(idle(), 'start', T0);
  assert.equal(C.applyAction(running, 'start', T0), null);
});

test('pause freezes the remaining time and resume restarts it from there', () => {
  const running = C.applyAction(idle(), 'start', T0);
  const paused = C.applyAction(running, 'pause', T0 + 10 * MIN);
  assert.equal(paused.phase, 'FOCUS_PAUSED');
  assert.equal(paused.remainingMs, 15 * MIN);
  assert.equal(paused.endsAtEpochMs, null);
  assert.equal(C.remaining(paused, T0 + 99 * MIN), 15 * MIN);

  const resumed = C.applyAction(paused, 'resume', T0 + 20 * MIN);
  assert.equal(resumed.endsAtEpochMs, T0 + 35 * MIN);
});

test('focus runs out into a break that starts at the exact boundary', () => {
  const running = C.applyAction(idle(), 'start', T0);
  assert.equal(C.tick(running, T0 + 25 * MIN - 1), null);
  const late = C.tick(running, T0 + 25 * MIN + 900);
  assert.equal(late.phase, 'BREAK');
  assert.equal(late.endsAtEpochMs, T0 + 30 * MIN, 'a late tick does not stretch the break');
});

test('a long stall lands on the phase that is actually current', () => {
  const running = C.applyAction(idle(), 'start', T0);
  assert.equal(C.tick(running, T0 + 31 * MIN).phase, 'ALARM');
  assert.equal(C.tick(running, T0 + 27 * MIN).phase, 'BREAK');
});

test('the alarm offers continue (new focus) or dismiss (idle)', () => {
  const alarm = C.tick(C.applyAction(idle(), 'start', T0), T0 + 31 * MIN);
  assert.equal(C.applyAction(alarm, 'dismiss-alarm', T0 + 32 * MIN).phase, 'IDLE');
  const again = C.applyAction(alarm, 'continue-session', T0 + 32 * MIN);
  assert.equal(again.phase, 'FOCUS');
  assert.equal(again.endsAtEpochMs, T0 + 57 * MIN);
});

test('a break can be paused, resumed and skipped', () => {
  const onBreak = C.tick(C.applyAction(idle(), 'start', T0), T0 + 26 * MIN);
  const paused = C.applyAction(onBreak, 'pause-break', T0 + 27 * MIN);
  assert.equal(paused.remainingMs, 3 * MIN);
  const resumed = C.applyAction(paused, 'resume-break', T0 + 40 * MIN);
  assert.equal(resumed.endsAtEpochMs, T0 + 43 * MIN);
  assert.equal(C.applyAction(resumed, 'skip-break', T0 + 41 * MIN).phase, 'IDLE');
});

test('every applied action advances seq, so peers can order states', () => {
  let s = idle();
  const seqs = [];
  for (const action of ['start', 'pause', 'resume', 'stop']) {
    s = C.applyAction(s, action, T0);
    seqs.push(s.seq);
  }
  assert.deepEqual(seqs, [1, 2, 3, 4]);
});

test('completing focus records a session and a focus-complete event', () => {
  const running = C.applyAction(idle(), 'start', T0);
  const done = C.tick(running, T0 + 25 * MIN);
  const events = C.transitionEvents(running, done, T0 + 25 * MIN);
  assert.deepEqual(events.map((e) => e.name), ['session', 'focus-complete']);
  const session = events[0].payload;
  assert.equal(session.focusMs, 25 * MIN);
  assert.equal(session.earnedMs, 5 * MIN);
  assert.equal(session.endReason, 'complete');
  assert.equal(session.room, true);
  assert.equal(session.mode, 'POMODORO');
});

test('stopping early records only the time actually focused', () => {
  const running = C.applyAction(idle(), 'start', T0);
  const stopped = C.applyAction(running, 'stop', T0 + 10 * MIN);
  const [event] = C.transitionEvents(running, stopped, T0 + 10 * MIN);
  assert.equal(event.payload.focusMs, 10 * MIN);
  assert.equal(event.payload.earnedMs, 0);
  assert.equal(event.payload.endReason, 'stop');
});

test('stopping a paused focus counts the time before the pause', () => {
  const running = C.applyAction(idle(), 'start', T0);
  const paused = C.applyAction(running, 'pause', T0 + 8 * MIN);
  const stopped = C.applyAction(paused, 'stop', T0 + 90 * MIN);
  const [event] = C.transitionEvents(paused, stopped, T0 + 90 * MIN);
  assert.equal(event.payload.focusMs, 8 * MIN);
});

test('stopping at the very start records nothing', () => {
  const running = C.applyAction(idle(), 'start', T0);
  const stopped = C.applyAction(running, 'stop', T0);
  assert.deepEqual(C.transitionEvents(running, stopped, T0), []);
});

test('alarm and alarm-stop events follow the phase', () => {
  const onBreak = C.tick(C.applyAction(idle(), 'start', T0), T0 + 26 * MIN);
  const alarm = C.tick(onBreak, T0 + 31 * MIN);
  assert.deepEqual(C.transitionEvents(onBreak, alarm, T0 + 31 * MIN).map((e) => e.name), ['alarm']);
  const dismissed = C.applyAction(alarm, 'dismiss-alarm', T0 + 32 * MIN);
  assert.deepEqual(C.transitionEvents(alarm, dismissed, T0 + 32 * MIN).map((e) => e.name), ['alarm-stop']);
  assert.deepEqual(C.transitionEvents(alarm, alarm, T0), []);
  assert.deepEqual(C.transitionEvents(null, alarm, T0), []);
});

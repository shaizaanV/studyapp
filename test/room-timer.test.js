'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { RoomTimer } = require('../src/main/room-timer');
const { TimerSource, ROOM_ACTIONS } = require('../src/main/timer-source');
const { TimerEngine } = require('../src/main/timer-engine');
const { DEFAULT_SETTINGS } = require('../src/main/constants');

const MIN = 60000;

function harness(overrides = {}) {
  let now = 1_800_000_000_000;
  const timer = new RoomTimer({ now: () => now, getSettings: () => ({ focusMin: 25, breakMin: 5, ...overrides }) });
  const events = [];
  const broadcasts = [];
  for (const name of ['session', 'focus-complete', 'alarm', 'alarm-stop']) timer.on(name, (p) => events.push({ name, p }));
  timer.on('broadcast', (s) => broadcasts.push(s));
  return {
    timer, events, broadcasts,
    advance(ms) { now += ms; timer.tick(); },
    get now() { return now; },
  };
}

test('a host runs a whole cycle and broadcasts every change', () => {
  const h = harness();
  h.timer.becomeHost({ hostSeq: 0, inherit: false });
  h.broadcasts.length = 0;

  h.timer.dispatch('start');
  assert.equal(h.timer.getState().phase, 'FOCUS');
  h.advance(25 * MIN);
  assert.equal(h.timer.getState().phase, 'BREAK');
  h.advance(5 * MIN);
  assert.equal(h.timer.getState().phase, 'ALARM');

  assert.deepEqual(h.events.map((e) => e.name), ['session', 'focus-complete', 'alarm']);
  assert.ok(h.broadcasts.length >= 3);
  const seqs = h.broadcasts.map((b) => b.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
});

test('getState has the same shape the renderer already consumes', () => {
  const h = harness();
  h.timer.becomeHost({ hostSeq: 0, inherit: false });
  h.timer.dispatch('start');
  h.advance(5 * MIN);
  const s = h.timer.getState();
  for (const field of ['mode', 'phase', 'focusMs', 'focusTargetMs', 'focusRemainingMs', 'wallTotalMs', 'wallRemainingMs',
    'wallInterrupted', 'breakTotalMs', 'breakRemainingMs', 'earned', 'earnedKind', 'pausedBySuspend', 'ring']) {
    assert.ok(field in s, field);
  }
  assert.equal(s.mode, 'POMODORO');
  assert.equal(s.focusRemainingMs, 20 * MIN);
  assert.equal(s.focusMs, 5 * MIN);
  assert.equal(s.ring.label, 'FOCUS');
  assert.ok(Math.abs(s.ring.progress - 0.2) < 1e-9);
  assert.deepEqual(s.room, { role: 'host' });
});

test('a follower shows the host state through its clock offset', () => {
  const h = harness();
  h.timer.becomeFollower({ offsetMs: 0 });
  const hostEndsAt = h.now + 10 * MIN + 5000; // on the host's clock, 5 s ahead of ours
  h.timer.applyRemote(
    { phase: 'FOCUS', endsAtEpochMs: hostEndsAt, remainingMs: null, focusMs: 25 * MIN, breakMs: 5 * MIN, hostSeq: 0, seq: 1 },
    5000
  );
  assert.equal(h.timer.getState().focusRemainingMs, 10 * MIN);
  assert.deepEqual(h.timer.getState().room, { role: 'follower' });

  h.timer.setOffset(0);
  assert.equal(h.timer.getState().focusRemainingMs, 10 * MIN + 5000);
});

test('a follower reports the same session events as the host', () => {
  const h = harness();
  h.timer.becomeFollower({ offsetMs: 0 });
  const base = { remainingMs: null, focusMs: 25 * MIN, breakMs: 5 * MIN, hostSeq: 0 };
  h.timer.applyRemote({ ...base, phase: 'FOCUS', endsAtEpochMs: h.now + 25 * MIN, seq: 1 });
  h.timer.applyRemote({ ...base, phase: 'BREAK', endsAtEpochMs: h.now + 5 * MIN, seq: 2 });
  h.timer.applyRemote({ ...base, phase: 'ALARM', endsAtEpochMs: null, seq: 3 });
  assert.deepEqual(h.events.map((e) => e.name), ['session', 'focus-complete', 'alarm']);
  assert.equal(h.events[0].p.room, true);
});

test('a follower cannot change the shared timer, only silence its own alarm', () => {
  const h = harness();
  h.timer.becomeFollower({ offsetMs: 0 });
  h.timer.dispatch('start');
  assert.equal(h.timer.getState().phase, 'IDLE');
  assert.equal(h.broadcasts.length, 0);

  const base = { remainingMs: null, focusMs: 25 * MIN, breakMs: 5 * MIN, hostSeq: 0 };
  h.timer.applyRemote({ ...base, phase: 'ALARM', endsAtEpochMs: null, seq: 1 });
  h.events.length = 0;
  h.timer.dispatch('dismiss-alarm');
  assert.deepEqual(h.events.map((e) => e.name), ['alarm-stop']);
  assert.equal(h.timer.getState().phase, 'ALARM', 'the room still shows the alarm until the host moves on');
});

test('taking over as host keeps the running phase and moves it onto the new clock', () => {
  const h = harness();
  h.timer.becomeFollower({ offsetMs: 2000 }); // host clock is 2 s ahead of ours
  h.timer.applyRemote({
    phase: 'FOCUS', endsAtEpochMs: h.now + 2000 + 12 * MIN, remainingMs: null,
    focusMs: 25 * MIN, breakMs: 5 * MIN, hostSeq: 0, seq: 7,
  }, 2000);
  h.broadcasts.length = 0;

  h.timer.becomeHost({ hostSeq: 1 });
  const taken = h.broadcasts[0];
  assert.equal(taken.hostSeq, 1);
  assert.equal(taken.seq, 8);
  assert.equal(taken.endsAtEpochMs, h.now + 12 * MIN);
  assert.equal(h.timer.getState().focusRemainingMs, 12 * MIN);
  assert.deepEqual(h.timer.getState().room, { role: 'host' });
});

test('host settings changes re-arm an idle room and are ignored mid-session', () => {
  let focusMin = 25;
  const timer = new RoomTimer({ getSettings: () => ({ focusMin, breakMin: 5 }) });
  timer.becomeHost({ hostSeq: 0, inherit: false });
  focusMin = 40;
  timer.setSettings();
  assert.equal(timer.getState().focusTargetMs, 40 * MIN);
  timer.dispatch('start');
  focusMin = 10;
  timer.setSettings();
  assert.equal(timer.getState().focusTargetMs, 40 * MIN);
});

// ---------------------------------------------------------------- TimerSource

function source() {
  const engine = new TimerEngine({ ...DEFAULT_SETTINGS });
  const timer = new RoomTimer({ getSettings: () => ({ focusMin: 25, breakMin: 5 }) });
  const src = new TimerSource(engine);
  const states = [];
  src.on('state', (s) => states.push(s));
  return { engine, timer, src, states };
}

test('TimerSource routes verbs to the local engine until a room is active', () => {
  const { engine, src } = source();
  src.dispatch('start');
  assert.equal(engine.getState().phase, 'FOCUS');
  assert.equal(src.getState().phase, 'FOCUS');
  src.dispatch('stop');
  src.dispatch('set-mode', 'FLOW');
  assert.equal(engine.getState().mode, 'FLOW');
});

test('while a room is active, verbs go to the room and local-only verbs are dropped', () => {
  const { engine, timer, src } = source();
  timer.becomeHost({ hostSeq: 0, inherit: false });
  src.useRoom(timer);

  src.dispatch('set-mode', 'FLOW');
  src.dispatch('abandon-wall');
  assert.equal(engine.getState().mode, 'POMODORO');
  assert.equal(src.getState().mode, 'POMODORO');

  src.dispatch('start');
  assert.equal(timer.getState().phase, 'FOCUS');
  assert.equal(engine.getState().phase, 'IDLE', 'the personal engine is untouched');
  assert.ok(src.getState().room);
  src.useLocal();
});

test('events from the inactive timer never leak through', () => {
  const { engine, timer, src } = source();
  const seen = [];
  src.on('session', (s) => seen.push(s));
  timer.becomeHost({ hostSeq: 0, inherit: false });
  src.useRoom(timer);

  engine.emit('session', { from: 'local' });
  timer.emit('session', { from: 'room' });
  assert.deepEqual(seen, [{ from: 'room' }]);

  src.useLocal();
  engine.emit('session', { from: 'local2' });
  timer.emit('session', { from: 'room2' });
  assert.deepEqual(seen, [{ from: 'room' }, { from: 'local2' }]);
});

test('switching timers pushes the new timer state to the UI', () => {
  const { timer, src, states } = source();
  timer.becomeHost({ hostSeq: 0, inherit: false });
  src.useRoom(timer);
  assert.ok(states.at(-1).room);
  src.useLocal();
  assert.equal(states.at(-1).room, undefined);
  assert.equal(timer.interval, null, 'the room timer stops ticking when left');
});

test('sleep and lock never touch a room timer', () => {
  const { engine, timer, src } = source();
  let suspended = 0;
  engine.handleSuspend = () => suspended++;
  timer.becomeHost({ hostSeq: 0, inherit: false });
  src.useRoom(timer);
  src.handleSuspend();
  assert.equal(suspended, 0);
  src.useLocal();
  src.handleSuspend();
  assert.equal(suspended, 1);
});

test('every room verb the host may run is a real clock action', () => {
  const C = require('../src/shared/room-clock');
  const idle = C.createIdle({ focusMs: 25 * MIN, breakMs: 5 * MIN });
  for (const verb of ROOM_ACTIONS) {
    // A verb must be recognised in at least one phase; "unknown" is null everywhere.
    const phases = ['IDLE', 'FOCUS', 'FOCUS_PAUSED', 'BREAK', 'BREAK_PAUSED', 'ALARM'].map((phase) => ({
      ...idle, phase, endsAtEpochMs: 10 * MIN, remainingMs: MIN,
    }));
    assert.ok(phases.some((s) => C.applyAction(s, verb, 0)), verb);
  }
});

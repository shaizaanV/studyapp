'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const P = require('../src/shared/room-protocol');

const roster = (over = {}) => ({
  roomId: 'room-1',
  rosterSeq: 1,
  hostSeq: 0,
  hostKey: 'b',
  members: ['b', 'c', 'a'],
  ...over,
});

const current = (over = {}) => ({ roomId: 'room-1', hostKey: 'b', hostSeq: 0, rosterSeq: 1, members: ['a', 'b', 'c'], ...over });

const timerBody = (over = {}) => ({
  phase: 'FOCUS', endsAtEpochMs: 1_000_000, hostSeq: 0, seq: 1, focusMs: 25 * 60000, breakMs: 5 * 60000, ...over,
});

const frame = (type, body, over = {}) => ({ v: 1, type, from: 'a', seq: 1, ts: 1, sig: 'sig', body, ...over });

test('canonicalJson sorts keys at every depth and ignores undefined', () => {
  assert.equal(P.canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[2,{"y":2,"z":1}]},"b":1}');
});

test('validateFrame accepts well formed frames and rejects bad envelopes', () => {
  assert.ok(P.validateFrame(frame('chat', { text: 'hi' })).ok);
  assert.ok(!P.validateFrame(frame('chat', { text: 'hi' }, { v: 2 })).ok);
  assert.ok(!P.validateFrame(frame('nope', {})).ok);
  assert.ok(!P.validateFrame(frame('chat', { text: 'hi' }, { sig: '' })).ok);
  assert.ok(!P.validateFrame(null).ok);
});

test('chat is capped at 2 KB measured in bytes, not characters', () => {
  assert.ok(P.validateFrame(frame('chat', { text: 'a'.repeat(2048) })).ok);
  assert.ok(!P.validateFrame(frame('chat', { text: 'a'.repeat(2049) })).ok);
  assert.ok(!P.validateFrame(frame('chat', { text: 'é'.repeat(1025) })).ok);
  assert.ok(!P.validateFrame(frame('chat', { text: '' })).ok);
});

test('timer-state requires an end time when running and remaining time when paused', () => {
  assert.ok(P.validateFrame(frame('timer-state', timerBody())).ok);
  assert.ok(!P.validateFrame(frame('timer-state', timerBody({ endsAtEpochMs: undefined }))).ok);
  assert.ok(P.validateFrame(frame('timer-state', timerBody({ phase: 'FOCUS_PAUSED', remainingMs: 5000 }))).ok);
  assert.ok(!P.validateFrame(frame('timer-state', timerBody({ phase: 'FOCUS_PAUSED' }))).ok);
});

test('timer-state rejects phases outside Pomodoro and out-of-range durations', () => {
  for (const phase of ['WALL', 'BREAK_PENDING', 'NOPE']) {
    assert.ok(!P.validateFrame(frame('timer-state', timerBody({ phase }))).ok, phase);
  }
  assert.ok(!P.validateFrame(frame('timer-state', timerBody({ focusMs: 10 }))).ok);
  assert.ok(!P.validateFrame(frame('timer-state', timerBody({ breakMs: 5 * 60 * 60000 }))).ok);
});

test('timer-action only allows the whitelisted verbs', () => {
  assert.ok(P.validateFrame(frame('timer-action', { action: 'pause' })).ok);
  assert.ok(!P.validateFrame(frame('timer-action', { action: 'set-mode' })).ok);
  assert.ok(!P.validateFrame(frame('timer-action', { action: 'abandon-wall' })).ok);
});

test('rosters are capped at 12, unique, and must contain their host', () => {
  assert.ok(P.validateRoster(roster()).ok);
  const twelve = Array.from({ length: 12 }, (_, i) => `k${i}`);
  assert.ok(P.validateRoster(roster({ members: twelve, hostKey: 'k0' })).ok);
  assert.ok(!P.validateRoster(roster({ members: [...twelve, 'k12'], hostKey: 'k0' })).ok);
  assert.ok(!P.validateRoster(roster({ members: ['a', 'a', 'b'] })).ok);
  assert.ok(!P.validateRoster(roster({ hostKey: 'z' })).ok);
});

test('quarantined channels admit only join-request frames', () => {
  assert.ok(P.allowedWhileQuarantined(frame('join-request', {})));
  for (const type of ['chat', 'timer-state', 'roster', 'signal-relay', 'heartbeat']) {
    assert.ok(!P.allowedWhileQuarantined(frame(type, {})), type);
  }
});

test('host claims order by hostSeq, then by lower key', () => {
  assert.ok(P.compareHostClaims({ hostSeq: 2, hostKey: 'z' }, { hostSeq: 1, hostKey: 'a' }) > 0);
  assert.ok(P.compareHostClaims({ hostSeq: 1, hostKey: 'a' }, { hostSeq: 1, hostKey: 'b' }) > 0);
  assert.ok(P.compareHostClaims({ hostSeq: 1, hostKey: 'b' }, { hostSeq: 1, hostKey: 'a' }) < 0);
  assert.equal(P.compareHostClaims({ hostSeq: 1, hostKey: 'a' }, { hostSeq: 1, hostKey: 'a' }), 0);
});

test('electHost picks the lowest reachable roster member and ignores strangers', () => {
  assert.equal(P.electHost(['c', 'a', 'b'], ['b', 'c']), 'b');
  assert.equal(P.electHost(['c', 'a', 'b'], ['x', 'c']), 'c');
  assert.equal(P.electHost(['a'], []), null);
});

test('a peer claims host only after 8 s of silence and only if it is the candidate', () => {
  const base = { roster: roster(), connectedKeys: ['a', 'c'], lastHostHeardAt: 0 };
  assert.equal(P.shouldClaimHost({ ...base, selfKey: 'a', now: 7999 }), false);
  assert.equal(P.shouldClaimHost({ ...base, selfKey: 'a', now: 8000 }), true);
  assert.equal(P.shouldClaimHost({ ...base, selfKey: 'c', now: 8000 }), false);
  // The silent host itself is never a candidate, even if it is lowest.
  const hostLowest = { ...base, roster: roster({ hostKey: 'a' }), connectedKeys: ['a', 'b', 'c'] };
  assert.equal(P.shouldClaimHost({ ...hostLowest, selfKey: 'b', now: 8000 }), true);
  assert.equal(P.shouldClaimHost({ ...hostLowest, selfKey: 'a', now: 8000 }), false);
});

test('acceptRoster: the current host may publish the next roster', () => {
  const next = roster({ rosterSeq: 2 });
  assert.ok(P.acceptRoster({ roster: next, signer: 'b', current: current() }).ok);
  assert.ok(!P.acceptRoster({ roster: roster({ rosterSeq: 1 }), signer: 'b', current: current() }).ok);
});

test('acceptRoster: a roster is rejected unless its host signed it', () => {
  const r = P.acceptRoster({ roster: roster({ rosterSeq: 2 }), signer: 'c', current: current() });
  assert.ok(!r.ok);
});

test('acceptRoster: a member who is not the host cannot seize control without a claim', () => {
  const forged = roster({ rosterSeq: 5, hostKey: 'c', hostSeq: 0 });
  assert.ok(!P.acceptRoster({ roster: forged, signer: 'c', current: current() }).ok);
});

test('acceptRoster: migration accepted from the lowest key with a higher hostSeq', () => {
  const claimRoster = roster({ rosterSeq: 2, hostKey: 'a', hostSeq: 1, members: ['a', 'c'] });
  const claim = { hostKey: 'a', hostSeq: 1 };
  assert.ok(P.acceptRoster({ roster: claimRoster, signer: 'a', current: current(), claim }).ok);
});

test('acceptRoster: migration from a non-lowest key at a higher hostSeq is rejected', () => {
  const claimRoster = roster({ rosterSeq: 2, hostKey: 'c', hostSeq: 1, members: ['a', 'c'] });
  const claim = { hostKey: 'c', hostSeq: 1 };
  assert.ok(!P.acceptRoster({ roster: claimRoster, signer: 'c', current: current(), claim }).ok);
});

test('acceptRoster: "lowest active" is judged from the acceptor\'s own view', () => {
  // 'a' is unreachable from here, so 'c' is the lowest reachable non-host key.
  const claimRoster = roster({ rosterSeq: 2, hostKey: 'c', hostSeq: 1, members: ['b', 'c'] });
  const claim = { hostKey: 'c', hostSeq: 1 };
  assert.ok(P.acceptRoster({ roster: claimRoster, signer: 'c', current: current(), claim, connectedKeys: ['c'] }).ok);
  assert.ok(!P.acceptRoster({ roster: claimRoster, signer: 'c', current: current(), claim, connectedKeys: ['a', 'c'] }).ok);
});

test('acceptRoster: a non-member can never take over, even with a claim', () => {
  const claimRoster = roster({ rosterSeq: 2, hostKey: 'A', hostSeq: 9, members: ['A'] });
  const claim = { hostKey: 'A', hostSeq: 9 };
  assert.ok(!P.acceptRoster({ roster: claimRoster, signer: 'A', current: current(), claim }).ok);
});

test('acceptRoster: a merge winner at equal hostSeq wins on the lower key', () => {
  const local = current({ hostKey: 'c', hostSeq: 1, members: ['a', 'b', 'c'] });
  const winner = roster({ rosterSeq: 3, hostKey: 'a', hostSeq: 1, members: ['a', 'b'] });
  const claim = { hostKey: 'a', hostSeq: 1 };
  assert.ok(P.acceptRoster({ roster: winner, signer: 'a', current: local, claim }).ok);
  // A higher key at equal hostSeq loses the same dispute.
  const loser = roster({ rosterSeq: 3, hostKey: 'c', hostSeq: 1, members: ['b', 'c'] });
  const localLow = current({ hostKey: 'a', hostSeq: 1 });
  assert.ok(!P.acceptRoster({ roster: loser, signer: 'c', current: localLow, claim: { hostKey: 'c', hostSeq: 1 } }).ok);
});

test('acceptRoster: rosters from another room are rejected', () => {
  assert.ok(!P.acceptRoster({ roster: roster({ roomId: 'other', rosterSeq: 2 }), signer: 'b', current: current() }).ok);
});

test('resolveMerge keeps the dominant claim and adopts the other', () => {
  assert.equal(P.resolveMerge({ hostSeq: 2, hostKey: 'z' }, { hostSeq: 1, hostKey: 'a' }), 'keep');
  assert.equal(P.resolveMerge({ hostSeq: 1, hostKey: 'z' }, { hostSeq: 2, hostKey: 'a' }), 'adopt');
  assert.equal(P.resolveMerge({ hostSeq: 1, hostKey: 'b' }, { hostSeq: 1, hostKey: 'a' }), 'adopt');
});

test('unmergedJoiners lists members the winner does not know', () => {
  assert.deepEqual(P.unmergedJoiners(roster({ members: ['a', 'b', 'x'] }), roster({ members: ['a', 'b'] })), ['x']);
});

test('clock offset is recovered exactly for a symmetric link', () => {
  // Host clock is 500 ms ahead; 40 ms each way; 10 ms host processing.
  const s = P.clockSample({ t0: 1000, t1: 1000 + 500 + 40, t2: 1000 + 500 + 50, t3: 1000 + 90 });
  assert.equal(s.offsetMs, 500);
  assert.equal(s.rttMs, 80);
});

test('estimateOffset trusts the lowest-RTT sample', () => {
  const noisy = { t0: 0, t1: 600, t2: 610, t3: 400 };
  const clean = { t0: 1000, t1: 1540, t2: 1550, t3: 1090 };
  assert.equal(P.estimateOffset([noisy, clean]).offsetMs, 500);
  assert.equal(P.estimateOffset([]), null);
});

test('remainingMs uses absolute end time on a running phase and offset for skew', () => {
  const state = timerBody({ endsAtEpochMs: 10_000 });
  assert.equal(P.remainingMs(state, 4000, 0), 6000);
  // Local clock is 1 s behind the host (offset = +1000): 1 s less remains.
  assert.equal(P.remainingMs(state, 4000, 1000), 5000);
  assert.equal(P.remainingMs(state, 20_000, 0), 0);
  assert.equal(P.remainingMs(timerBody({ phase: 'BREAK_PAUSED', remainingMs: 1234 }), 0, 0), 1234);
  assert.equal(P.remainingMs(timerBody({ phase: 'IDLE' }), 0, 0), 0);
});

test('stale timer state is ignored by hostSeq, then by seq', () => {
  const latest = { hostSeq: 2, seq: 5 };
  assert.equal(P.isStaleTimerState({ hostSeq: 1, seq: 99 }, latest), true);
  assert.equal(P.isStaleTimerState({ hostSeq: 2, seq: 5 }, latest), true);
  assert.equal(P.isStaleTimerState({ hostSeq: 2, seq: 6 }, latest), false);
  assert.equal(P.isStaleTimerState({ hostSeq: 3, seq: 0 }, latest), false);
  assert.equal(P.isStaleTimerState({ hostSeq: 0, seq: 0 }, null), false);
});

test('rate limiter allows a burst of 5, then refills at 5 per second per sender', () => {
  const limiter = P.createRateLimiter();
  const results = Array.from({ length: 6 }, () => limiter.allow('a', 0));
  assert.deepEqual(results, [true, true, true, true, true, false]);
  assert.equal(limiter.allow('b', 0), true, 'other senders are unaffected');
  assert.equal(limiter.allow('a', 200), true, '200 ms refills one token');
  assert.equal(limiter.allow('a', 200), false);
  limiter.forget('a');
  assert.equal(limiter.allow('a', 200), true);
});

test('a peer leaves after more than 60 s disconnected', () => {
  assert.equal(P.shouldLeaveAfterWake(60000), false);
  assert.equal(P.shouldLeaveAfterWake(60001), true);
});

test('admission is refused when full, duplicate, or stale', () => {
  const twelve = Array.from({ length: 12 }, (_, i) => `k${i}`);
  const full = roster({ members: twelve, hostKey: 'k0' });
  assert.ok(!P.canAdmit({ roster: full, joinerKey: 'new', requestedAt: 0, now: 1 }).ok);
  assert.ok(!P.canAdmit({ roster: roster(), joinerKey: 'a', requestedAt: 0, now: 1 }).ok);
  assert.ok(!P.canAdmit({ roster: roster(), joinerKey: 'new', requestedAt: 0, now: 60001 }).ok);
  assert.ok(P.canAdmit({ roster: roster(), joinerKey: 'new', requestedAt: 0, now: 60000 }).ok);
});

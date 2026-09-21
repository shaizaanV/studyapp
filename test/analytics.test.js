'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const analytics = require('../src/main/analytics');

const MIN = 60000;
const DAY = 24 * 60 * MIN;

/** A fixed local noon, so day arithmetic never straddles midnight. */
const NOW = new Date(2026, 8, 10, 12).getTime();

const flow = (minutes, endedAt = NOW) => ({
  mode: 'FLOW',
  focusMs: minutes * MIN,
  earnedMs: 1,
  endedAt,
  endReason: 'stop',
});

const pomodoro = (minutes, endReason, endedAt = NOW) => ({
  mode: 'POMODORO',
  focusMs: minutes * MIN,
  earnedMs: endReason === 'complete' ? 17 * MIN : 0,
  endedAt,
  endReason,
});

test('a flow session splits into the three tier windows', () => {
  const rollup = analytics.createRollup();
  analytics.applySession(rollup, flow(127));

  const day = rollup.days[analytics.dayKey(NOW)];
  assert.deepEqual(
    day.tierMs.map((ms) => ms / MIN),
    [60, 30, 37]
  );
});

test('pomodoro focus counts toward totals but never toward tiers', () => {
  const rollup = analytics.createRollup();
  analytics.applySession(rollup, pomodoro(52, 'complete'));

  const day = rollup.days[analytics.dayKey(NOW)];
  assert.equal(day.focusMs, 52 * MIN);
  assert.deepEqual(day.tierMs, [0, 0, 0]);
});

test('lifetime index: total, longest flow, average before a stop', () => {
  const rollup = analytics.createRollup();
  analytics.applySession(rollup, flow(40));
  analytics.applySession(rollup, flow(130));
  // A long completed pomodoro: counts in the total, but it is neither a flow
  // (so it cannot be the longest flow) nor a stop (it ran to completion).
  analytics.applySession(rollup, pomodoro(200, 'complete'));
  analytics.applySession(rollup, pomodoro(30, 'stop'));

  const { lifetime } = analytics.summarize(rollup, NOW);
  assert.equal(lifetime.focusMs, 400 * MIN, 'every session counts toward the total');
  assert.equal(lifetime.longestFlowMs, 130 * MIN, 'only flow sessions compete for longest');
  assert.equal(lifetime.stops, 3, 'two flow stops and one early pomodoro stop');
  // The engine reports whole milliseconds.
  assert.equal(lifetime.avgBeforeStopMs, Math.round(((40 + 130 + 30) * MIN) / 3));
});

test('sessions from before 4.0 have their end reason inferred', () => {
  assert.equal(analytics.endReasonOf({ mode: 'FLOW', earnedMs: 900000 }), 'stop');
  assert.equal(analytics.endReasonOf({ mode: 'POMODORO', earnedMs: 1020000 }), 'complete');
  assert.equal(analytics.endReasonOf({ mode: 'POMODORO', earnedMs: 0 }), 'stop');
});

test('the 30-day window is consecutive, zero-filled, and ends today', () => {
  const rollup = analytics.createRollup();
  analytics.applySession(rollup, flow(45, NOW - 3 * DAY));

  const { daily30, tiers7 } = analytics.summarize(rollup, NOW);
  assert.equal(daily30.length, 30);
  assert.equal(daily30.at(-1).key, analytics.dayKey(NOW));

  // Each key is exactly one calendar day after the last, whatever the timezone
  // or daylight-saving rules -- keys are dates, so compare them as UTC dates.
  const asUtc = (key) => Date.UTC(...key.split('-').map((n, i) => Number(n) - (i === 1 ? 1 : 0)));
  for (let i = 1; i < daily30.length; i++) {
    assert.equal(asUtc(daily30[i].key) - asUtc(daily30[i - 1].key), DAY, `gap at ${i}`);
  }

  assert.equal(daily30.filter((d) => d.focusMs > 0).length, 1, 'empty days are zero, not missing');
  assert.equal(daily30.at(-4).focusMs, 45 * MIN);
  assert.deepEqual(
    tiers7.map((d) => d.key),
    daily30.slice(-7).map((d) => d.key),
    'the tier chart covers the last seven of those days'
  );
});

test('tier totals sum only the trailing seven days', () => {
  const rollup = analytics.createRollup();
  analytics.applySession(rollup, flow(100, NOW - 2 * DAY)); // in the window
  analytics.applySession(rollup, flow(100, NOW - 10 * DAY)); // outside it

  const { tierTotals7 } = analytics.summarize(rollup, NOW);
  assert.deepEqual(
    tierTotals7.map((ms) => ms / MIN),
    [60, 30, 10]
  );
});

test('lifetime survives past the 500-session history cap', () => {
  const rollup = analytics.createRollup();
  for (let i = 0; i < 600; i++) analytics.applySession(rollup, flow(30, NOW - i * MIN));

  assert.equal(rollup.lifetime.sessions, 600);
  assert.equal(rollup.lifetime.focusMs, 600 * 30 * MIN);
});

test('rebuilding from history matches folding sessions in one at a time', () => {
  const sessions = [
    flow(20, NOW - 5 * DAY),
    pomodoro(52, 'complete', NOW - 4 * DAY),
    flow(95, NOW - 1 * DAY),
    pomodoro(12, 'stop', NOW),
  ];

  const incremental = analytics.createRollup();
  for (const s of sessions) analytics.applySession(incremental, s);

  assert.deepEqual(analytics.rebuildRollup(sessions), incremental);
});

test('old days are pruned; lifetime totals are not', () => {
  const rollup = analytics.createRollup();
  const span = analytics.RETAIN_DAYS + 60;
  for (let i = span; i >= 0; i--) analytics.applySession(rollup, flow(10, NOW - i * DAY));

  const keys = Object.keys(rollup.days).sort();
  const cutoff = analytics.dayKey(analytics.shiftDays(new Date(NOW), -analytics.RETAIN_DAYS));
  assert.ok(keys.length < span, 'the day map is bounded');
  assert.ok(keys[0] >= analytics.dayKey(NOW - (analytics.RETAIN_DAYS + 31) * DAY), `oldest ${keys[0]}, cutoff ${cutoff}`);
  assert.equal(rollup.lifetime.sessions, span + 1, 'lifetime still counts every session');
});

test('a corrupt rollup file is rejected so it can be rebuilt', () => {
  assert.equal(analytics.normalizeRollup(null), null);
  assert.equal(analytics.normalizeRollup({ version: 99 }), null);
  assert.equal(analytics.normalizeRollup({ version: 1, lifetime: {} }), null);

  const cleaned = analytics.normalizeRollup({
    version: 1,
    lifetime: { focusMs: -5, sessions: 'x', longestFlowAt: 'never' },
    days: { 'not-a-date': {}, '2026-09-10': { focusMs: NaN, sessions: 2, tierMs: [1, -1] } },
  });
  assert.equal(cleaned.lifetime.focusMs, 0);
  assert.equal(cleaned.lifetime.sessions, 0);
  assert.equal(cleaned.lifetime.longestFlowAt, null);
  assert.deepEqual(Object.keys(cleaned.days), ['2026-09-10']);
  assert.deepEqual(cleaned.days['2026-09-10'], { focusMs: 0, sessions: 2, tierMs: [1, 0, 0] });
});

test("today's strip reads a single day entry", () => {
  const rollup = analytics.createRollup();
  analytics.applySession(rollup, flow(30, NOW - DAY));
  analytics.applySession(rollup, flow(45));
  analytics.applySession(rollup, pomodoro(25, 'stop'));

  assert.deepEqual(analytics.todayFrom(rollup, NOW), { focusMs: 70 * MIN, sessions: 2 });
});

test('zero-length and malformed sessions are ignored', () => {
  const rollup = analytics.createRollup();
  analytics.applySession(rollup, flow(0));
  analytics.applySession(rollup, { mode: 'FLOW', focusMs: 5 * MIN, endedAt: 'soon' });
  analytics.applySession(rollup, null);

  assert.equal(rollup.lifetime.sessions, 0);
  assert.deepEqual(rollup.days, {});
});

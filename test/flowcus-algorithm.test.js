'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeBreak } = require('../src/main/flowcus-algorithm');

/** Tolerance for floating point multiplication of minute values. */
const close = (actual, expected, message) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${message}: expected ${expected}, got ${actual}`
  );

test('reference table from the specification', () => {
  const cases = [
    { focus: 0, t1: 0, t2: 0, t3: 0, total: 0 },
    { focus: 45, t1: 11.25, t2: 0, t3: 0, total: 11.25 },
    { focus: 60, t1: 15, t2: 0, t3: 0, total: 15 },
    { focus: 75, t1: 15, t2: 6, t3: 0, total: 21 },
    { focus: 90, t1: 15, t2: 12, t3: 0, total: 27 },
    { focus: 120, t1: 15, t2: 12, t3: 18, total: 45 },
    { focus: 180, t1: 15, t2: 12, t3: 54, total: 81 },
  ];

  for (const c of cases) {
    const result = computeBreak(c.focus);
    close(result.tiers[0].earnedMinutes, c.t1, `${c.focus}min tier 1`);
    close(result.tiers[1].earnedMinutes, c.t2, `${c.focus}min tier 2`);
    close(result.tiers[2].earnedMinutes, c.t3, `${c.focus}min tier 3`);
    close(result.totalMinutes, c.total, `${c.focus}min total`);
  }
});

test('tier boundaries are exact, with no double counting', () => {
  // At exactly 60 minutes tier 1 is full and tier 2 has not opened.
  const at60 = computeBreak(60);
  close(at60.tiers[0].minutesInTier, 60, 'tier 1 window at 60');
  close(at60.tiers[1].minutesInTier, 0, 'tier 2 window at 60');

  // At exactly 90 minutes tier 2 is full and tier 3 has not opened.
  const at90 = computeBreak(90);
  close(at90.tiers[1].minutesInTier, 30, 'tier 2 window at 90');
  close(at90.tiers[2].minutesInTier, 0, 'tier 3 window at 90');

  // One minute past each boundary spills into exactly one tier.
  close(computeBreak(61).tiers[1].minutesInTier, 1, 'tier 2 window at 61');
  close(computeBreak(91).tiers[2].minutesInTier, 1, 'tier 3 window at 91');
});

test('tier windows never exceed their own width', () => {
  const huge = computeBreak(10000);
  close(huge.tiers[0].minutesInTier, 60, 'tier 1 width');
  close(huge.tiers[1].minutesInTier, 30, 'tier 2 width');
  close(huge.tiers[2].minutesInTier, 9910, 'tier 3 width');
});

test('caps are consistent with the windows, so nothing is clipped', () => {
  // 60 x 0.25 = 15 and 30 x 0.40 = 12, exactly the stated caps.
  const saturated = computeBreak(90);
  assert.equal(saturated.tiers[0].capped, false, 'tier 1 should never clip');
  assert.equal(saturated.tiers[1].capped, false, 'tier 2 should never clip');
});

test('tier 3 is uncapped and keeps accruing at 0.6 per minute', () => {
  const a = computeBreak(200);
  const b = computeBreak(260);
  close(b.totalMinutes - a.totalMinutes, 36, 'an extra hour past 90min earns 36min');
  assert.equal(b.tiers[2].cap, Infinity, 'tier 3 cap');
  assert.equal(b.tiers[2].capped, false, 'tier 3 never reports as capped');
});

test('totalMs is a whole number of milliseconds', () => {
  const result = computeBreak(45);
  assert.equal(result.totalMs, 675000, '11.25 minutes in ms');
  assert.equal(Number.isInteger(result.totalMs), true);
});

test('the active flag drives which breakdown rows light up', () => {
  const short = computeBreak(30);
  assert.deepEqual(
    short.tiers.map((t) => t.active),
    [true, false, false],
    'only tier 1 is active at 30 minutes'
  );

  const long = computeBreak(150);
  assert.deepEqual(
    long.tiers.map((t) => t.active),
    [true, true, true],
    'all tiers are active at 150 minutes'
  );
});

test('invalid and negative input degrades to zero rather than NaN', () => {
  for (const bad of [-10, NaN, Infinity, undefined, null, 'abc', {}]) {
    const result = computeBreak(bad);
    assert.equal(result.totalMinutes, 0, `input ${String(bad)} yields no break`);
    assert.equal(Number.isNaN(result.totalMs), false, `input ${String(bad)} is not NaN`);
  }
});

test('fractional focus time is handled precisely', () => {
  close(computeBreak(0.5).totalMinutes, 0.125, 'half a minute');
  close(computeBreak(95.5).totalMinutes, 15 + 12 + 3.3, '95.5 minutes');
});

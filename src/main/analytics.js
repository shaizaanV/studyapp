'use strict';

/**
 * Analytics rollup: pure functions, no I/O, no Electron.
 *
 * Session history on disk is capped, so it cannot answer lifetime questions
 * on its own -- the oldest sessions fall off the end. Instead every session is
 * folded, once, into a small running aggregate:
 *
 *   lifetime  totals that only ever grow (focus, sessions, longest flow, stops)
 *   days      one entry per local calendar day: focus, sessions, tier split
 *
 * Folding a session is O(1). Summarising for the dashboard is O(30): one map
 * lookup per day in the window, independent of how many sessions exist.
 */

const { computeBreak } = require('./flowcus-algorithm');

const MINUTE_MS = 60000;

const ROLLUP_VERSION = 1;

/** Days of per-day detail retained. Comfortably covers every window the dashboard shows. */
const RETAIN_DAYS = 400;

/** Pruning only runs once the map overshoots by this much, so it is amortised. */
const PRUNE_SLACK = 30;

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n) => String(n).padStart(2, '0');

/** Local-calendar day key, e.g. "2026-09-10". Keys sort lexicographically in date order. */
function dayKey(dateOrMs) {
  const d = dateOrMs instanceof Date ? dateOrMs : new Date(dateOrMs);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The date `offset` local days away from `from`, pinned to local noon so a
 * daylight-saving shift can never push it across midnight into the wrong day.
 */
function shiftDays(from, offset) {
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset, 12);
}

function createRollup() {
  return {
    version: ROLLUP_VERSION,
    lifetime: {
      focusMs: 0,
      sessions: 0,
      flowSessions: 0,
      longestFlowMs: 0,
      longestFlowAt: null,
      stops: 0,
      stopFocusMs: 0,
      firstSessionAt: null,
    },
    days: {},
  };
}

/**
 * How a session ended. Sessions written before 4.0 carry no endReason, so it
 * is inferred: flow sessions only ever end with Stop, and a pomodoro that
 * earned a break ran to completion while one that earned nothing was stopped.
 */
function endReasonOf(session) {
  if (session.endReason === 'stop' || session.endReason === 'complete') return session.endReason;
  if (session.mode === 'FLOW') return 'stop';
  return Number(session.earnedMs) > 0 ? 'complete' : 'stop';
}

/** Focus ms that landed inside each tier window, reusing the engine's own maths. */
function tierSplitMs(focusMs) {
  return computeBreak(focusMs / MINUTE_MS).tiers.map((tier) =>
    Math.round(tier.minutesInTier * MINUTE_MS)
  );
}

/**
 * Drops per-day entries older than the retention window. O(days), but only
 * called when a brand-new day key appears -- at most once per calendar day --
 * so the cost per session is amortised O(1).
 */
function pruneDays(rollup, nowMs) {
  const keys = Object.keys(rollup.days);
  if (keys.length <= RETAIN_DAYS + PRUNE_SLACK) return;
  const cutoff = dayKey(shiftDays(new Date(nowMs), -RETAIN_DAYS));
  for (const key of keys) {
    if (key < cutoff) delete rollup.days[key];
  }
}

/**
 * Folds one session into the rollup. Mutates and returns it. O(1) amortised.
 *
 * @param {object} rollup
 * @param {{mode:string, focusMs:number, earnedMs?:number, endedAt:number, endReason?:string}} session
 */
function applySession(rollup, session) {
  if (!session || typeof session !== 'object') return rollup;

  const focusMs = Math.max(0, Number(session.focusMs) || 0);
  const endedAt = Number(session.endedAt);
  if (!Number.isFinite(endedAt) || focusMs <= 0) return rollup;

  const isFlow = session.mode === 'FLOW';
  const life = rollup.lifetime;

  life.focusMs += focusMs;
  life.sessions += 1;
  if (life.firstSessionAt === null || endedAt < life.firstSessionAt) {
    life.firstSessionAt = endedAt;
  }

  if (isFlow) {
    life.flowSessions += 1;
    if (focusMs > life.longestFlowMs) {
      life.longestFlowMs = focusMs;
      life.longestFlowAt = endedAt;
    }
  }

  if (endReasonOf(session) === 'stop') {
    life.stops += 1;
    life.stopFocusMs += focusMs;
  }

  // Attributed to the day the session ended. A session spanning midnight
  // counts toward the later day -- simpler than splitting it, and off by at
  // most one session at the boundary.
  const key = dayKey(endedAt);
  let day = rollup.days[key];
  if (!day) {
    day = { focusMs: 0, sessions: 0, tierMs: [0, 0, 0] };
    rollup.days[key] = day;
    pruneDays(rollup, endedAt);
  }

  day.focusMs += focusMs;
  day.sessions += 1;

  // Tiers are a flow concept: a pomodoro never passes through tier states.
  if (isFlow) {
    const split = tierSplitMs(focusMs);
    day.tierMs[0] += split[0];
    day.tierMs[1] += split[1];
    day.tierMs[2] += split[2];
  }

  return rollup;
}

/** Rebuilds a rollup from raw session history. O(n); used once, on migration. */
function rebuildRollup(sessions) {
  const rollup = createRollup();
  if (!Array.isArray(sessions)) return rollup;
  for (const session of sessions) applySession(rollup, session);
  return rollup;
}

const nonNegative = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/**
 * Validates a rollup read from disk. Returns null when it is unusable, which
 * tells the store to rebuild from history rather than trust a bad file.
 */
function normalizeRollup(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== ROLLUP_VERSION) return null;
  if (!raw.lifetime || typeof raw.lifetime !== 'object') return null;
  if (!raw.days || typeof raw.days !== 'object') return null;

  const rollup = createRollup();

  for (const field of Object.keys(rollup.lifetime)) {
    const value = raw.lifetime[field];
    if (field.endsWith('At')) {
      rollup.lifetime[field] = Number.isFinite(value) ? value : null;
    } else {
      rollup.lifetime[field] = nonNegative(value);
    }
  }

  for (const key of Object.keys(raw.days)) {
    const day = raw.days[key];
    if (!DAY_KEY_PATTERN.test(key) || !day || typeof day !== 'object') continue;
    const tiers = Array.isArray(day.tierMs) ? day.tierMs : [];
    rollup.days[key] = {
      focusMs: nonNegative(day.focusMs),
      sessions: nonNegative(day.sessions),
      tierMs: [nonNegative(tiers[0]), nonNegative(tiers[1]), nonNegative(tiers[2])],
    };
  }

  return rollup;
}

/** Today's focus strip under the dial. O(1). */
function todayFrom(rollup, nowMs = Date.now()) {
  const day = rollup.days[dayKey(nowMs)];
  return { focusMs: day ? day.focusMs : 0, sessions: day ? day.sessions : 0 };
}

/**
 * Everything the dashboard draws, computed in one pass over a fixed 30-day
 * window. O(30), regardless of how much history exists.
 */
function summarize(rollup, nowMs = Date.now()) {
  const today = new Date(nowMs);

  const daily30 = [];
  for (let offset = -29; offset <= 0; offset++) {
    const date = shiftDays(today, offset);
    const key = dayKey(date);
    const day = rollup.days[key];
    daily30.push({
      key,
      date: date.getTime(),
      focusMs: day ? day.focusMs : 0,
      sessions: day ? day.sessions : 0,
      tierMs: day ? day.tierMs.slice() : [0, 0, 0],
    });
  }

  const tiers7 = daily30.slice(-7).map((day) => ({
    key: day.key,
    date: day.date,
    tierMs: day.tierMs,
  }));

  const tierTotals7 = [0, 0, 0];
  for (const day of tiers7) {
    tierTotals7[0] += day.tierMs[0];
    tierTotals7[1] += day.tierMs[1];
    tierTotals7[2] += day.tierMs[2];
  }

  const life = rollup.lifetime;

  return {
    generatedAt: nowMs,
    lifetime: {
      focusMs: life.focusMs,
      sessions: life.sessions,
      flowSessions: life.flowSessions,
      longestFlowMs: life.longestFlowMs,
      longestFlowAt: life.longestFlowAt,
      stops: life.stops,
      avgBeforeStopMs: life.stops > 0 ? Math.round(life.stopFocusMs / life.stops) : 0,
      firstSessionAt: life.firstSessionAt,
    },
    daily30: daily30.map(({ key, date, focusMs, sessions }) => ({ key, date, focusMs, sessions })),
    tiers7,
    tierTotals7,
  };
}

module.exports = {
  ROLLUP_VERSION,
  RETAIN_DAYS,
  createRollup,
  applySession,
  rebuildRollup,
  normalizeRollup,
  summarize,
  todayFrom,
  endReasonOf,
  tierSplitMs,
  dayKey,
  shiftDays,
};

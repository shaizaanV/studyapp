'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const { DEFAULT_SETTINGS, LIMITS } = require('./constants');
const analytics = require('./analytics');

/**
 * Raw sessions kept on disk. This is detail, not the source of truth for
 * lifetime numbers: the analytics rollup is, because it never loses the
 * sessions that fall off the end of this cap.
 */
const MAX_HISTORY = 500;

const settingsPath = () => path.join(app.getPath('userData'), 'flowcus-settings.json');
const historyPath = () => path.join(app.getPath('userData'), 'flowcus-history.json');
const analyticsPath = () => path.join(app.getPath('userData'), 'flowcus-analytics.json');

// Only the main process ever writes these files, so an in-memory copy is
// authoritative after the first read and saves a disk read per session.
let historyCache = null;
let rollupCache = null;

/**
 * Writes JSON without risking a truncated file if the process dies mid-write:
 * serialise to a sibling temp file first, then rename over the target.
 */
function writeJsonAtomic(filePath, value) {
  const tmp = `${filePath}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
    return true;
  } catch (err) {
    console.error(`[flowcus] failed to write ${filePath}:`, err.message);
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* the temp file may not exist; nothing to clean up */
    }
    return false;
  }
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    // Missing or corrupt file: fall back rather than refusing to start.
    return fallback;
  }
}

const clamp = (value, { min, max }, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/** Only http(s) links may ever reach shell.openExternal. */
function isSafeUrl(url) {
  try {
    const { protocol } = new URL(String(url));
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

let rewardCounter = 0;
const makeRewardId = () => `r-${Date.now().toString(36)}-${(rewardCounter++).toString(36)}`;

/**
 * Coerces anything loaded from disk or sent over IPC into a settings object
 * that the rest of the app can trust without re-checking.
 */
function normalizeSettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};

  const rewards = Array.isArray(input.rewards)
    ? input.rewards
        .map((entry) => {
          if (!entry || typeof entry !== 'object') return null;
          const url = String(entry.url || '').trim();
          if (!isSafeUrl(url)) return null;
          const label = String(entry.label || '').trim().slice(0, 40) || 'Reward';
          return { id: String(entry.id || makeRewardId()), label, url };
        })
        .filter(Boolean)
        .slice(0, 12)
    : DEFAULT_SETTINGS.rewards.map((r) => ({ ...r }));

  return {
    focusMin: clamp(input.focusMin, LIMITS.focusMin, DEFAULT_SETTINGS.focusMin),
    breakMin: clamp(input.breakMin, LIMITS.breakMin, DEFAULT_SETTINGS.breakMin),
    soundEnabled: input.soundEnabled !== false,
    alarmVolume: clamp(input.alarmVolume, LIMITS.alarmVolume, DEFAULT_SETTINGS.alarmVolume),
    autoStartBreak: input.autoStartBreak === true,
    wallMethodEnabled: input.wallMethodEnabled === true,
    shareAnonymousStats: input.shareAnonymousStats !== false,
    rewards,
  };
}

function loadSettings() {
  return normalizeSettings(readJson(settingsPath(), DEFAULT_SETTINGS));
}

function saveSettings(raw) {
  const settings = normalizeSettings(raw);
  writeJsonAtomic(settingsPath(), settings);
  return settings;
}

function loadHistory() {
  if (historyCache) return historyCache;
  const history = readJson(historyPath(), []);
  historyCache = Array.isArray(history) ? history : [];
  return historyCache;
}

/**
 * The analytics rollup. On first run after upgrading to 4.0 there is no
 * rollup file yet, so it is rebuilt once from the existing session history
 * -- O(n), a single time -- and every later session is folded in at O(1).
 */
function loadRollup() {
  if (rollupCache) return rollupCache;
  const stored = analytics.normalizeRollup(readJson(analyticsPath(), null));
  if (stored) {
    rollupCache = stored;
  } else {
    rollupCache = analytics.rebuildRollup(loadHistory());
    writeJsonAtomic(analyticsPath(), rollupCache);
  }
  return rollupCache;
}

/**
 * @param {{mode:string, focusMs:number, earnedMs:number, endedAt:number, endReason:string}} session
 */
function appendSession(session) {
  // The rollup is written first: it is what the dashboard trusts, so if the
  // process dies between the two writes the aggregate is the one that is right.
  analytics.applySession(loadRollup(), session);
  writeJsonAtomic(analyticsPath(), rollupCache);

  const history = loadHistory();
  history.push(session);
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  writeJsonAtomic(historyPath(), history);
  return history;
}

/** Focus totals since local midnight, for the strip under the dial. O(1). */
function todayStats() {
  return analytics.todayFrom(loadRollup());
}

/** Everything the analytics dashboard draws. O(30). */
function analyticsSummary() {
  return analytics.summarize(loadRollup());
}

module.exports = {
  loadSettings,
  saveSettings,
  normalizeSettings,
  loadHistory,
  appendSession,
  todayStats,
  analyticsSummary,
  isSafeUrl,
  settingsPath,
  historyPath,
  analyticsPath,
};

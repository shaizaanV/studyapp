'use strict';

/**
 * Application User Model ID. This MUST stay identical to `appId` in
 * electron-builder.yml -- Windows matches toasts against the AUMID stamped on
 * the Start Menu shortcut the installer creates. If the two ever drift apart,
 * every notification is silently dropped with no error.
 */
const APP_ID = 'com.flowcus.app';

/** Authoritative clock resolution, in the main process. */
const TICK_MS = 250;

const MODES = {
  POMODORO: 'POMODORO',
  FLOW: 'FLOW',
};

const PHASES = {
  IDLE: 'IDLE',
  FOCUS: 'FOCUS',
  FOCUS_PAUSED: 'FOCUS_PAUSED',
  BREAK_PENDING: 'BREAK_PENDING',
  BREAK: 'BREAK',
  BREAK_PAUSED: 'BREAK_PAUSED',
  ALARM: 'ALARM',
  // Wall Method pre-focus baseline. Deliberately outside the focus phases so
  // its time can never reach the focus accumulator or the tier engine.
  WALL: 'WALL',
};

/**
 * Length of the Wall Method baseline. Fixed rather than a setting: the
 * protocol is a strict ten minutes, and making it adjustable invites trimming.
 */
const WALL_MS = 10 * 60000;

/**
 * The Flowcus 3.0 piecewise tiers.
 *
 * Each tier converts only the focus minutes that fall inside its own window.
 * The caps are self-consistent with the window widths (60 x 0.25 = 15,
 * 30 x 0.40 = 12), so they act as guardrails rather than altering results.
 * Tier 3 is uncapped: every minute past the 90 minute mark earns 0.6 minutes
 * of break, with no ceiling.
 */
const TIERS = [
  { id: 1, label: 'Tier 1', from: 0, to: 60, rate: 0.25, cap: 15 },
  { id: 2, label: 'Tier 2', from: 60, to: 90, rate: 0.4, cap: 12 },
  { id: 3, label: 'Tier 3', from: 90, to: Infinity, rate: 0.6, cap: Infinity },
];

/** Window geometry. Mini mode is deliberately tiny: ring + digits, nothing else. */
const WINDOW = {
  normal: { width: 460, height: 640, minWidth: 400, minHeight: 560 },
  mini: { width: 240, height: 84 },
};

const DEFAULT_SETTINGS = {
  focusMin: 52,
  breakMin: 17,
  soundEnabled: true,
  alarmVolume: 0.9,
  autoStartBreak: false,
  wallMethodEnabled: false,
  shareAnonymousStats: true,
  rewards: [
    { id: 'r-cgpgrey', label: 'CGP Grey', url: 'https://www.youtube.com/@CGPGrey' },
    { id: 'r-kurzgesagt', label: 'Kurzgesagt', url: 'https://www.youtube.com/@kurzgesagt' },
    { id: 'r-veritasium', label: 'Veritasium', url: 'https://www.youtube.com/@veritasium' },
  ],
};

/** Numeric settings bounds, enforced on every save. */
const LIMITS = {
  focusMin: { min: 1, max: 240 },
  breakMin: { min: 1, max: 120 },
  alarmVolume: { min: 0, max: 1 },
};

module.exports = {
  APP_ID,
  TICK_MS,
  MODES,
  PHASES,
  WALL_MS,
  TIERS,
  WINDOW,
  DEFAULT_SETTINGS,
  LIMITS,
};

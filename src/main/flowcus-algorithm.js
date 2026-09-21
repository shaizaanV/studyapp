'use strict';

const { TIERS } = require('./constants');

/** Guards against floating point noise when comparing against a tier cap. */
const EPSILON = 1e-9;

/**
 * The Flowcus 3.0 multi-tier break engine.
 *
 * Converts accumulated focus minutes into earned break minutes using a
 * piecewise schedule. Each tier only ever sees the minutes that fall inside
 * its own window, so the rates never compound:
 *
 *   tier1 = min(f, 60)            x 0.25   capped at 15
 *   tier2 = clamp(f - 60, 0, 30)  x 0.40   capped at 12
 *   tier3 = max(f - 90, 0)        x 0.60   uncapped
 *
 * Pure: no I/O, no clock access, no state. Everything the UI needs to render
 * the breakdown box is returned here so the renderer never recomputes it.
 *
 * @param {number} focusMinutes Focus time in minutes. May be fractional.
 * @returns {{focusMinutes:number, tiers:Array, totalMinutes:number, totalMs:number}}
 */
function computeBreak(focusMinutes) {
  const focus = Number.isFinite(Number(focusMinutes)) ? Math.max(0, Number(focusMinutes)) : 0;

  const tiers = TIERS.map((tier) => {
    // Only the slice of `focus` that lands inside [from, to) belongs to this tier.
    const minutesInTier = Math.max(0, Math.min(focus, tier.to) - tier.from);
    const raw = minutesInTier * tier.rate;
    const earned = Math.min(raw, tier.cap);

    return {
      id: tier.id,
      label: tier.label,
      from: tier.from,
      to: tier.to,
      rate: tier.rate,
      cap: tier.cap,
      minutesInTier,
      earnedMinutes: earned,
      capped: raw > tier.cap + EPSILON,
      active: minutesInTier > EPSILON,
    };
  });

  const totalMinutes = tiers.reduce((sum, tier) => sum + tier.earnedMinutes, 0);

  return {
    focusMinutes: focus,
    tiers,
    totalMinutes,
    totalMs: Math.round(totalMinutes * 60000),
  };
}

module.exports = { computeBreak };

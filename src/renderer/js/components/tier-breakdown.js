'use strict';

/**
 * The mathematical breakdown box.
 *
 * Shows exactly how each tier turned focus minutes into break minutes, so the
 * earned total is never a black box. Tiers that contributed nothing are dimmed
 * rather than hidden, which keeps the ladder visible as a goal.
 */
(function () {
  const Flowcus = (window.Flowcus = window.Flowcus || {});
  const { el, formatClock, formatNumber } = Flowcus.util;

  /** "0-60", "60-90", "90+" */
  function windowLabel(tier) {
    if (!Number.isFinite(tier.to)) return tier.from + '+';
    return tier.from + '-' + tier.to;
  }

  function tierRow(tier) {
    const classes = ['tier-row'];
    classes.push(tier.active ? 'active' : 'idle');

    const math = el('div', { class: 'tier-math' }, [
      el('b', { text: formatNumber(tier.minutesInTier) + ' min' }),
      ' in ' + windowLabel(tier) + '  × ' + tier.rate.toFixed(2),
    ]);

    return el('div', { class: classes.join(' ') }, [
      el('div', { class: 'tier-name', text: 'T' + tier.id }),
      math,
      el('div', {
        class: 'tier-earned',
        text: formatClock(tier.earnedMinutes * 60000),
      }),
    ]);
  }

  /**
   * @param {HTMLElement} container
   * @param {object|null} breakdown Result of computeBreak, or null for a fixed break.
   * @param {number} fixedMs Break length to show when there is no tier breakdown.
   */
  function renderBreakdown(container, breakdown, fixedMs) {
    if (!breakdown) {
      // Pomodoro breaks are a flat configured length, so there is no ladder to show.
      container.replaceChildren(
        el('div', { class: 'breakdown-empty' }, [
          'Fixed Pomodoro break of ' + formatClock(fixedMs) + '.',
        ])
      );
      return;
    }

    const rows = breakdown.tiers.map(tierRow);

    rows.push(
      el('div', { class: 'tier-row total' }, [
        el('div', { class: 'tier-name', text: 'TOTAL' }),
        el('div', {
          class: 'tier-math',
          text: 'from ' + formatNumber(breakdown.focusMinutes) + ' min of focus',
        }),
        el('div', {
          class: 'tier-earned',
          text: formatClock(breakdown.totalMs),
        }),
      ])
    );

    container.replaceChildren.apply(container, rows);
  }

  Flowcus.renderBreakdown = renderBreakdown;
})();

'use strict';

/**
 * Analytics panel: a lifetime index, a 30-day focus trend, and a 7-day tier
 * distribution. Every number comes precomputed from the main process rollup
 * in one O(30) summary; this view only lays it out.
 *
 * Each chart has a table twin behind its "Table" toggle, so no value is ever
 * reachable only by hovering.
 */
(function () {
  const Flowcus = (window.Flowcus = window.Flowcus || {});
  const { el, formatStat } = Flowcus.util;
  const charts = Flowcus.charts;

  const HOUR_MS = 3600000;

  const TIERS = [
    { key: 's-t1', name: 'Tier 1', range: '0–60m' },
    { key: 's-t2', name: 'Tier 2', range: '60–90m' },
    { key: 's-t3', name: 'Tier 3', range: '90m+' },
  ];

  const dom = {};
  const tableMode = { daily: false, tiers: false };
  let data = null;
  let visible = false;
  let animateNext = true;
  let resizeFrame = 0;
  let lastWidth = 0;

  /** Durations under a minute read as seconds rather than a misleading "0m". */
  function formatDuration(ms) {
    if (ms > 0 && ms < 60000) return Math.round(ms / 1000) + 's';
    return formatStat(ms);
  }

  /** Lifetime hours: one decimal while small, whole hours once large. */
  function formatHours(ms) {
    const hours = ms / HOUR_MS;
    if (hours === 0) return '0';
    return hours < 100 ? hours.toFixed(1) : String(Math.round(hours));
  }

  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

  // ------------------------------------------------------------------ index

  function kpiTile(label, value, unit, caption) {
    return el('div', { class: 'kpi' }, [
      el('div', { class: 'kpi-label', text: label }),
      el('div', { class: 'kpi-value' }, [value, unit ? el('span', { class: 'kpi-unit', text: unit }) : null]),
      el('div', { class: 'kpi-caption', text: caption }),
    ]);
  }

  function renderIndex() {
    const life = data.lifetime;

    dom.kpis.replaceChildren(
      kpiTile(
        'Lifetime focus',
        formatHours(life.focusMs),
        'h',
        life.sessions > 0 ? 'across ' + plural(life.sessions, 'session') : 'No sessions yet'
      ),
      kpiTile(
        'Longest flow',
        life.longestFlowMs > 0 ? formatDuration(life.longestFlowMs) : '—',
        null,
        life.longestFlowAt ? 'on ' + charts.shortDate(life.longestFlowAt) : 'No flow sessions yet'
      ),
      kpiTile(
        'Avg before stop',
        life.stops > 0 ? formatDuration(life.avgBeforeStopMs) : '—',
        null,
        life.stops > 0 ? 'across ' + plural(life.stops, 'stop') : 'No stops yet'
      )
    );

    dom.since.textContent = life.firstSessionAt ? 'Since ' + charts.shortDate(life.firstSessionAt) : '';
  }

  // ------------------------------------------------------------ daily trend

  function renderDaily() {
    let total = 0;
    for (const day of data.daily30) total += day.focusMs;
    dom.dailySub.textContent =
      formatStat(total) + ' in 30 days · ' + formatStat(total / 30) + ' a day on average';

    if (tableMode.daily) {
      const rows = data.daily30
        .slice()
        .reverse()
        .map((day, i) =>
          el('tr', null, [
            el('td', { text: i === 0 ? 'Today' : charts.longDate(day.date) }),
            el('td', { text: formatStat(day.focusMs) }),
            el('td', { text: String(day.sessions) }),
          ])
        );
      dom.dailyBody.replaceChildren(table(['Day', 'Focus', 'Sessions'], rows));
      return;
    }

    charts.areaChart(dom.dailyBody, data.daily30, {
      label: 'Daily focus minutes over the last 30 days',
      animate: animateNext,
    });
  }

  // ------------------------------------------------------ tier distribution

  function renderTiers() {
    const grand = data.tierTotals7[0] + data.tierTotals7[1] + data.tierTotals7[2];

    dom.tierLegend.replaceChildren.apply(
      dom.tierLegend,
      TIERS.map((tier, t) => {
        const ms = data.tierTotals7[t];
        const share = grand > 0 ? Math.round((ms / grand) * 100) : 0;
        return el('div', { class: 'legend-item' }, [
          el('div', { class: 'legend-key' }, [
            el('span', { class: 'legend-swatch ' + tier.key }),
            el('span', { class: 'legend-name', text: tier.name }),
            el('span', { class: 'legend-range', text: tier.range }),
          ]),
          el('div', { class: 'legend-figures' }, [
            el('span', { class: 'legend-value', text: formatStat(ms) }),
            el('span', { class: 'legend-share', text: share + '%' }),
          ]),
        ]);
      })
    );

    if (tableMode.tiers) {
      const last = data.tiers7.length - 1;
      const rows = data.tiers7
        .map((day, i) =>
          el('tr', null, [
            el('td', { text: i === last ? 'Today' : charts.longDate(day.date) }),
            el('td', { text: formatStat(day.tierMs[0]) }),
            el('td', { text: formatStat(day.tierMs[1]) }),
            el('td', { text: formatStat(day.tierMs[2]) }),
            el('td', { text: formatStat(day.tierMs[0] + day.tierMs[1] + day.tierMs[2]) }),
          ])
        )
        .reverse();
      dom.tiersBody.replaceChildren(table(['Day', 'T1', 'T2', 'T3', 'Total'], rows));
      return;
    }

    charts.tierBars(dom.tiersBody, data.tiers7, {
      label: 'Flow focus minutes per tier, per day, over the last 7 days',
      animate: animateNext,
    });
  }

  function table(headings, rows) {
    return el('div', { class: 'viz-table-wrap' }, [
      el('table', { class: 'viz-table' }, [
        el('thead', null, [el('tr', null, headings.map((h) => el('th', { text: h })))]),
        el('tbody', null, rows),
      ]),
    ]);
  }

  // ---------------------------------------------------------------- render

  function render() {
    if (!data) return;
    renderIndex();
    renderDaily();
    renderTiers();
    // Only the first render after opening animates; refreshes hold still.
    animateNext = false;
  }

  async function load() {
    // The previous render stays on screen while this resolves -- no flash.
    data = await window.flowcus.requestAnalytics();
    if (visible) render();
  }

  function open() {
    visible = true;
    animateNext = true;
    load();
  }

  function close() {
    visible = false;
  }

  /** New session logged: redraw in place if the panel is showing. */
  function refresh() {
    if (visible) load();
  }

  function setTableMode(name, enabled) {
    tableMode[name] = enabled;
    const toggle = name === 'daily' ? dom.dailyToggle : dom.tiersToggle;
    toggle.setAttribute('aria-pressed', String(enabled));
    toggle.textContent = enabled ? 'Chart' : 'Table';
    if (name === 'daily') renderDaily();
    else renderTiers();
  }

  function onResize() {
    const width = dom.dailyBody.clientWidth;
    if (!visible || !data || width === lastWidth) return;
    lastWidth = width;
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      if (!tableMode.daily) renderDaily();
      if (!tableMode.tiers) renderTiers();
    });
  }

  function init() {
    dom.kpis = document.getElementById('kpi-row');
    dom.since = document.getElementById('analytics-since');
    dom.dailySub = document.getElementById('daily-sub');
    dom.dailyBody = document.getElementById('chart-daily');
    dom.tiersBody = document.getElementById('chart-tiers');
    dom.tierLegend = document.getElementById('tier-legend');
    dom.dailyToggle = document.getElementById('toggle-daily');
    dom.tiersToggle = document.getElementById('toggle-tiers');

    dom.dailyToggle.addEventListener('click', () => setTableMode('daily', !tableMode.daily));
    dom.tiersToggle.addEventListener('click', () => setTableMode('tiers', !tableMode.tiers));

    // Charts are drawn at the card's real pixel width, so redraw when it changes.
    new ResizeObserver(onResize).observe(dom.dailyBody);
  }

  Flowcus.analyticsView = { init, open, close, refresh };
})();

'use strict';

/**
 * Dependency-free SVG charts for the analytics panel.
 *
 * Each chart is drawn from scratch into inline SVG in a single O(n) pass over
 * its points (30 days, 7 days) and simply redrawn on data or size change --
 * at these sizes a full redraw is cheaper and simpler than diffing.
 *
 * Colour never goes in a style attribute (the page CSP forbids them). Marks
 * carry classes, and analytics.css maps those classes to colour tokens.
 * Positioning that must be computed (the tooltip) goes through the CSSOM,
 * which the CSP permits.
 */
(function () {
  const Flowcus = (window.Flowcus = window.Flowcus || {});
  const { el, formatStat } = Flowcus.util;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MINUTE_MS = 60000;

  /** Axis steps in minutes, picked so every tick label is a clean number. */
  const STEPS_MIN = [5, 10, 15, 30, 60, 120, 180, 240, 360, 480, 720];
  const MAX_TICKS = 4;

  /** Surface gap between touching bar segments. */
  const SEGMENT_GAP = 2;
  /** Rounded radius on a bar's data end; the baseline end stays square. */
  const END_RADIUS = 4;
  /** A non-zero segment is never drawn thinner than this, or it vanishes. */
  const MIN_SEGMENT = 2;

  function svgEl(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (const key of Object.keys(attrs)) node.setAttribute(key, String(attrs[key]));
    }
    return node;
  }

  const shortDate = (ms) =>
    new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const longDate = (ms) =>
    new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const weekday = (ms) => new Date(ms).toLocaleDateString(undefined, { weekday: 'short' });

  /** The smallest clean step that covers `maxMs` in at most four intervals. */
  function niceScale(maxMs, floorMs) {
    const maxMin = Math.max(maxMs, floorMs) / MINUTE_MS;
    let step = STEPS_MIN[STEPS_MIN.length - 1];
    for (const candidate of STEPS_MIN) {
      if (Math.ceil(maxMin / candidate) <= MAX_TICKS) {
        step = candidate;
        break;
      }
    }
    const count = Math.max(1, Math.ceil(maxMin / step));
    return { stepMs: step * MINUTE_MS, count, maxMs: count * step * MINUTE_MS };
  }

  function formatTick(ms) {
    const minutes = Math.round(ms / MINUTE_MS);
    if (minutes === 0) return '0';
    if (minutes < 60) return minutes + 'm';
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? hours + 'h' : hours + 'h ' + rest + 'm';
  }

  const round1 = (n) => Math.round(n * 10) / 10;

  function rectPath(x, y, w, h) {
    return `M${round1(x)} ${round1(y)}H${round1(x + w)}V${round1(y + h)}H${round1(x)}Z`;
  }

  /** A bar segment rounded on its data end only, square where it meets the baseline. */
  function roundedEndPath(x, y, w, h) {
    const r = Math.min(END_RADIUS, h / 2, w);
    const right = x + w;
    return (
      `M${round1(x)} ${round1(y)}H${round1(right - r)}` +
      `A${r} ${r} 0 0 1 ${round1(right)} ${round1(y + r)}` +
      `V${round1(y + h - r)}` +
      `A${r} ${r} 0 0 1 ${round1(right - r)} ${round1(y + h)}` +
      `H${round1(x)}Z`
    );
  }

  /**
   * Plays the entrance transition: marks start collapsed onto their baseline
   * and grow out. Two frames guarantee the collapsed state is painted first,
   * or the browser skips straight to the end state.
   */
  function reveal(nodes, animate) {
    if (!animate) return;
    for (const node of nodes) node.classList.add('pre');
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        for (const node of nodes) node.classList.remove('pre');
      })
    );
  }

  /**
   * One tooltip per chart. Values lead and labels follow; every string goes in
   * through textContent, never innerHTML.
   */
  function createTooltip(host) {
    const tip = el('div', { class: 'viz-tip' });
    tip.hidden = true;
    host.append(tip);

    return {
      show(anchorX, anchorY, title, rows) {
        const children = [el('div', { class: 'viz-tip-title', text: title })];
        for (const row of rows) {
          children.push(
            el('div', { class: 'viz-tip-row' }, [
              row.key ? el('span', { class: 'viz-key ' + row.key }) : null,
              el('span', { class: 'viz-tip-value', text: row.value }),
              row.label ? el('span', { class: 'viz-tip-label', text: row.label }) : null,
            ])
          );
        }
        tip.replaceChildren.apply(tip, children);
        tip.hidden = false;

        // Centred over the anchor, kept inside the card, flipped below if it
        // would leave the top edge.
        const width = tip.offsetWidth;
        const height = tip.offsetHeight;
        const left = Math.max(0, Math.min(host.clientWidth - width, anchorX - width / 2));
        let top = anchorY - height - 12;
        if (top < 0) top = anchorY + 14;
        tip.style.left = left + 'px';
        tip.style.top = top + 'px';
      },
      hide() {
        tip.hidden = true;
      },
    };
  }

  function emptyNote(host, text, className) {
    host.append(el('div', { class: 'viz-empty ' + (className || ''), text }));
  }

  // ------------------------------------------------------------ area chart

  const AREA = { plotBottom: 150, axisBand: 22, top: 12, left: 46, right: 10 };

  /**
   * Single-series area chart with a snapping crosshair.
   *
   * @param {HTMLElement} host
   * @param {Array<{date:number, focusMs:number, sessions:number}>} points Oldest first.
   * @param {{label:string, animate:boolean}} options
   */
  function areaChart(host, points, options) {
    host.replaceChildren();
    if (points.length < 2) return;

    const width = Math.max(240, host.clientWidth);
    // The container's height includes the x-axis band, so labels never force
    // a nested scroll inside the card.
    const height = AREA.plotBottom + AREA.axisBand;
    const plotWidth = width - AREA.left - AREA.right;
    const plotHeight = AREA.plotBottom - AREA.top;
    const last = points.length - 1;
    const step = plotWidth / last;

    let max = 0;
    for (const point of points) if (point.focusMs > max) max = point.focusMs;
    const scale = niceScale(max, 30 * MINUTE_MS);

    const xAt = (i) => AREA.left + i * step;
    const yAt = (ms) => AREA.plotBottom - (ms / scale.maxMs) * plotHeight;

    const svg = svgEl('svg', {
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      class: 'viz-svg',
      role: 'img',
      tabindex: 0,
      'aria-label': options.label,
    });

    // Gridlines and y ticks: solid hairlines, snapped to the pixel grid.
    for (let k = 0; k <= scale.count; k++) {
      const value = k * scale.stepMs;
      const y = Math.round(yAt(value)) + 0.5;
      svg.append(
        svgEl('line', {
          x1: AREA.left,
          x2: width - AREA.right,
          y1: y,
          y2: y,
          class: k === 0 ? 'viz-baseline' : 'viz-gridline',
        })
      );
      const tick = svgEl('text', { x: AREA.left - 8, y: y + 3.5, 'text-anchor': 'end', class: 'viz-tick' });
      tick.textContent = formatTick(value);
      svg.append(tick);
    }

    // Three x labels: the window's start, its middle, and today.
    for (const i of [0, Math.floor(last / 2), last]) {
      let anchor = 'middle';
      if (i === 0) anchor = 'start';
      if (i === last) anchor = 'end';
      const label = svgEl('text', {
        x: xAt(i),
        y: AREA.plotBottom + 16,
        'text-anchor': anchor,
        class: 'viz-tick',
      });
      label.textContent = i === last ? 'Today' : shortDate(points[i].date);
      svg.append(label);
    }

    // Line and area built in one pass.
    let line = '';
    for (let i = 0; i <= last; i++) {
      line += (i === 0 ? 'M' : 'L') + round1(xAt(i)) + ' ' + round1(yAt(points[i].focusMs));
    }
    const area = `${line}L${round1(xAt(last))} ${AREA.plotBottom}L${round1(xAt(0))} ${AREA.plotBottom}Z`;

    const marks = svgEl('g', { class: 'viz-reveal viz-reveal-y' });
    marks.append(svgEl('path', { d: area, class: 'viz-area' }), svgEl('path', { d: line, class: 'viz-line' }));

    // Today's endpoint, ringed in the surface colour.
    const endDot = svgEl('circle', {
      cx: xAt(last),
      cy: yAt(points[last].focusMs),
      r: 4,
      class: 'viz-dot viz-fade',
    });

    const crosshair = svgEl('line', {
      y1: AREA.top,
      y2: AREA.plotBottom,
      class: 'viz-crosshair',
      visibility: 'hidden',
    });
    const hoverDot = svgEl('circle', { r: 4, class: 'viz-dot', visibility: 'hidden' });

    // The hit target is the whole plot, so the reader aims at a date, never a 2px line.
    const hit = svgEl('rect', {
      x: AREA.left - step / 2,
      y: 0,
      width: plotWidth + step,
      height: AREA.plotBottom,
      class: 'viz-hit viz-hit-x',
    });

    svg.append(marks, endDot, crosshair, hoverDot, hit);
    host.append(svg);
    reveal([marks, endDot], options.animate);

    if (max === 0) emptyNote(host, 'No focus logged in the last 30 days', 'viz-empty-area');

    const tooltip = createTooltip(host);
    let active = -1;

    function activate(index) {
      active = Math.max(0, Math.min(last, index));
      const point = points[active];
      const x = xAt(active);
      const y = yAt(point.focusMs);

      crosshair.setAttribute('x1', x);
      crosshair.setAttribute('x2', x);
      crosshair.setAttribute('visibility', 'visible');
      hoverDot.setAttribute('cx', x);
      hoverDot.setAttribute('cy', y);
      hoverDot.setAttribute('visibility', 'visible');

      tooltip.show(x, y, active === last ? 'Today' : longDate(point.date), [
        {
          key: 'series',
          value: formatStat(point.focusMs),
          label: point.sessions === 1 ? '1 session' : point.sessions + ' sessions',
        },
      ]);
    }

    function clear() {
      active = -1;
      crosshair.setAttribute('visibility', 'hidden');
      hoverDot.setAttribute('visibility', 'hidden');
      tooltip.hide();
    }

    hit.addEventListener('pointermove', (event) => {
      const x = event.clientX - svg.getBoundingClientRect().left;
      // O(1): the nearest day is arithmetic on an even spacing, not a search.
      activate(Math.round((x - AREA.left) / step));
    });
    hit.addEventListener('pointerleave', clear);

    // Keyboard gets the same readout as hover.
    svg.addEventListener('focus', () => activate(active < 0 ? last : active));
    svg.addEventListener('blur', clear);
    svg.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        activate(active + (event.key === 'ArrowLeft' ? -1 : 1));
      }
    });
  }

  // ------------------------------------------------------------- tier bars

  const BARS = { rowHeight: 30, barHeight: 12, labelWidth: 50, valueWidth: 60, pad: 2 };
  const TIER_NAMES = ['Tier 1', 'Tier 2', 'Tier 3'];

  /**
   * Horizontal stacked bars: one row per day, segmented by tier. The total
   * rides at each bar's tip, so no value axis is needed; per-tier values live
   * in the tooltip and the table view.
   *
   * @param {HTMLElement} host
   * @param {Array<{date:number, tierMs:number[]}>} days Oldest first.
   * @param {{label:string, animate:boolean}} options
   */
  function tierBars(host, days, options) {
    host.replaceChildren();

    const width = Math.max(240, host.clientWidth);
    const height = BARS.pad * 2 + days.length * BARS.rowHeight;
    const plotX = BARS.labelWidth;
    const plotWidth = width - BARS.labelWidth - BARS.valueWidth;
    const last = days.length - 1;

    const totals = days.map((day) => day.tierMs[0] + day.tierMs[1] + day.tierMs[2]);
    let max = 0;
    for (const total of totals) if (total > max) max = total;

    const svg = svgEl('svg', {
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      class: 'viz-svg',
      role: 'img',
      tabindex: 0,
      'aria-label': options.label,
    });

    const rows = [];
    const revealed = [];

    days.forEach((day, i) => {
      const rowTop = BARS.pad + i * BARS.rowHeight;
      const barY = rowTop + (BARS.rowHeight - BARS.barHeight) / 2;
      const textY = barY + BARS.barHeight / 2 + 4;
      const row = svgEl('g', { class: 'viz-row' });

      const label = svgEl('text', { x: 0, y: textY, class: 'viz-row-label' });
      label.textContent = i === last ? 'Today' : weekday(day.date);
      row.append(label);

      const bar = svgEl('g', { class: 'viz-reveal viz-reveal-x' });
      const segments = [];
      for (let t = 0; t < 3; t++) if (day.tierMs[t] > 0) segments.push(t);

      let x = plotX;
      segments.forEach((t, s) => {
        const isEnd = s === segments.length - 1;
        const span = max > 0 ? (day.tierMs[t] / max) * plotWidth : 0;
        // Every segment but the last gives up 2px to the surface gap.
        const drawn = Math.max(MIN_SEGMENT, span - (isEnd ? 0 : SEGMENT_GAP));
        bar.append(
          svgEl('path', {
            d: isEnd ? roundedEndPath(x, barY, drawn, BARS.barHeight) : rectPath(x, barY, drawn, BARS.barHeight),
            class: 'viz-seg s-t' + (t + 1),
          })
        );
        x += isEnd ? drawn : Math.max(span, drawn + SEGMENT_GAP);
      });
      row.append(bar);
      if (segments.length > 0) revealed.push(bar);

      const value = svgEl('text', {
        x: segments.length > 0 ? x + 8 : plotX + 8,
        y: textY,
        class: totals[i] > 0 ? 'viz-value' : 'viz-value muted',
      });
      value.textContent = totals[i] > 0 ? formatStat(totals[i]) : '—';
      row.append(value);

      // The whole row band is the hit target, not just the painted bar.
      const hit = svgEl('rect', { x: 0, y: rowTop, width, height: BARS.rowHeight, class: 'viz-hit' });
      row.append(hit);

      svg.append(row);
      rows.push({ node: row, hit, anchorX: segments.length > 0 ? x : plotX + plotWidth / 2, anchorY: barY });
    });

    // The shared baseline every bar grows from.
    svg.append(
      svgEl('line', {
        x1: plotX - 0.5,
        x2: plotX - 0.5,
        y1: BARS.pad,
        y2: height - BARS.pad,
        class: 'viz-baseline',
      })
    );

    host.append(svg);
    // Stagger the rows slightly so the chart reads top to bottom as it arrives.
    revealed.forEach((node, i) => {
      node.style.transitionDelay = i * 35 + 'ms';
    });
    reveal(revealed, options.animate);

    if (max === 0) emptyNote(host, 'No flow sessions in the last 7 days', 'viz-empty-bars');

    const tooltip = createTooltip(host);
    let active = -1;

    function activate(index) {
      active = Math.max(0, Math.min(last, index));
      const day = days[active];
      rows.forEach((row, i) => row.node.classList.toggle('active', i === active));
      svg.classList.add('has-active');

      tooltip.show(
        rows[active].anchorX,
        rows[active].anchorY,
        (active === last ? 'Today' : longDate(day.date)) + ' · ' + formatStat(totals[active]),
        TIER_NAMES.map((name, t) => ({
          key: 's-t' + (t + 1),
          value: formatStat(day.tierMs[t]),
          label: name,
        }))
      );
    }

    function clear() {
      active = -1;
      svg.classList.remove('has-active');
      rows.forEach((row) => row.node.classList.remove('active'));
      tooltip.hide();
    }

    rows.forEach((row, i) => row.hit.addEventListener('pointerenter', () => activate(i)));
    svg.addEventListener('pointerleave', clear);

    svg.addEventListener('focus', () => activate(active < 0 ? last : active));
    svg.addEventListener('blur', clear);
    svg.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        activate(active + (event.key === 'ArrowUp' ? -1 : 1));
      }
    });
  }

  Flowcus.charts = { areaChart, tierBars, niceScale, formatTick, shortDate, longDate, weekday };
})();

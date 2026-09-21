'use strict';

/**
 * SVG progress ring.
 *
 * The stroke colour is bound to var(--accent) through the element's inline
 * style rather than a presentation attribute, so it follows the mode/phase
 * accent swap automatically.
 */
(function () {
  const Flowcus = (window.Flowcus = window.Flowcus || {});

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const RADIUS = 44;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

  function circle(strokeWidth) {
    const node = document.createElementNS(SVG_NS, 'circle');
    node.setAttribute('cx', '50');
    node.setAttribute('cy', '50');
    node.setAttribute('r', String(RADIUS));
    node.setAttribute('fill', 'none');
    node.setAttribute('stroke-width', String(strokeWidth));
    node.setAttribute('stroke-linecap', 'round');
    return node;
  }

  /**
   * @param {HTMLElement} container
   * @param {{strokeWidth?: number}} [options]
   */
  function createRing(container, options) {
    const strokeWidth = (options && options.strokeWidth) || 4.5;

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');

    const track = circle(strokeWidth);
    track.style.stroke = 'var(--surface-3)';

    const value = circle(strokeWidth);
    value.style.stroke = 'var(--accent)';
    value.style.transition = 'stroke-dashoffset 0.3s linear, stroke 0.35s ease';
    value.setAttribute('stroke-dasharray', String(CIRCUMFERENCE));
    value.setAttribute('stroke-dashoffset', String(CIRCUMFERENCE));
    // Start the sweep at twelve o'clock instead of three.
    value.setAttribute('transform', 'rotate(-90 50 50)');

    svg.append(track, value);
    container.replaceChildren(svg);

    let last = -1;

    return {
      setProgress(progress) {
        const clamped = Math.min(1, Math.max(0, Number(progress) || 0));
        if (Math.abs(clamped - last) < 0.0005) return;
        last = clamped;
        value.setAttribute('stroke-dashoffset', String(CIRCUMFERENCE * (1 - clamped)));
      },
    };
  }

  Flowcus.createRing = createRing;
})();

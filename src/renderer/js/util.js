'use strict';

/**
 * Shared formatting helpers.
 *
 * Loaded first; every other renderer script reads from window.Flowcus.
 */
(function () {
  const Flowcus = (window.Flowcus = window.Flowcus || {});

  const pad = (n) => String(n).padStart(2, '0');

  /**
   * Clock readout. Stays as M:SS until an hour is reached, then widens to
   * H:MM:SS -- flow sessions regularly run past an hour.
   */
  function formatClock(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours > 0) return hours + ':' + pad(minutes) + ':' + pad(seconds);
    return minutes + ':' + pad(seconds);
  }

  /** Compact human total: "2h 14m", "2h", "45m", "0m". */
  function formatStat(ms) {
    const totalMinutes = Math.floor(Math.max(0, ms) / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0) return minutes === 0 ? hours + 'h' : hours + 'h ' + minutes + 'm';
    return minutes + 'm';
  }

  /** Trims pointless decimals: 60 -> "60", 11.25 -> "11.3", 0.5 -> "0.5". */
  function formatNumber(value) {
    const rounded = Math.round(value * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  }

  /** Replaces the children of an element with the given nodes. */
  function render(container, nodes) {
    container.replaceChildren.apply(container, [].concat(nodes));
  }

  /** Small DOM builder: el('button', { class: 'btn' }, 'Label'). */
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const key of Object.keys(attrs)) {
        const value = attrs[key];
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
        else node.setAttribute(key, value === true ? '' : value);
      }
    }
    if (children !== undefined && children !== null) {
      for (const child of [].concat(children)) {
        if (child === null || child === undefined || child === false) continue;
        node.append(child);
      }
    }
    return node;
  }

  Flowcus.util = { formatClock, formatStat, formatNumber, render, el, pad };
})();

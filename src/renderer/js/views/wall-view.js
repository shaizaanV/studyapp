'use strict';

/**
 * The Wall Method baseline screen.
 *
 * Almost nothing is drawn on purpose: a dimmed dot to fixate on, one line of
 * instruction, and a faint countdown. There is no pause and no skip -- the
 * baseline is a strict ten minutes -- only an Abandon control that stays
 * invisible until the pointer goes looking for it.
 */
(function () {
  const Flowcus = (window.Flowcus = window.Flowcus || {});
  const { formatClock } = Flowcus.util;

  const dom = {};

  function update(state) {
    dom.remaining.textContent = formatClock(state.wallRemainingMs);
  }

  function init(context) {
    dom.remaining = document.getElementById('wall-remaining');
    document
      .getElementById('wall-abandon')
      .addEventListener('click', () => context.send('abandon-wall'));
  }

  Flowcus.wallView = { init, update };
})();

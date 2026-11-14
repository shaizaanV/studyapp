'use strict';

/**
 * Plays the startup animation (styles/splash.css) and then removes it.
 *
 * It never gets in the way: the overlay ignores the pointer from the start, is
 * skipped entirely for the mini widget and for people who ask for reduced
 * motion, and is removed on a timer even if the animation events never fire.
 */
(function () {
  const splash = document.getElementById('splash');
  if (!splash) return;

  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // The window opens as the mini widget when it was last closed that way; no splash there.
  const mini = window.innerWidth < 300 || window.innerHeight < 200;
  if (reduced || mini) {
    splash.remove();
    return;
  }

  const finish = () => splash.remove();
  // Starts a beat after load so the first frames are not spent on window creation.
  requestAnimationFrame(() => requestAnimationFrame(() => splash.classList.add('play')));
  splash.addEventListener('animationend', (event) => {
    if (event.animationName === 'splash-out') finish();
  });
  setTimeout(finish, 3200);
})();

'use strict';

/**
 * Renderer entry point.
 *
 * The renderer deliberately owns no timing truth. It subscribes to state
 * pushed from the main process and draws it; every action is a verb sent back
 * over the narrow preload bridge.
 */
(function () {
  const Flowcus = (window.Flowcus = window.Flowcus || {});
  const { formatClock } = Flowcus.util;

  const BREAK_PHASES = ['BREAK_PENDING', 'BREAK', 'BREAK_PAUSED', 'ALARM'];

  /** How often the titlebar's global total is re-fetched. */
  const GLOBAL_STATS_POLL_MS = 5 * 60000;

  // Solid glyphs use a class rather than an inline style attribute: the page's
  // CSP forbids inline styles, and a stylesheet rule also beats the presentation
  // attributes that `svg { fill: none }` would otherwise override.
  const ICONS = {
    play: '<svg viewBox="0 0 16 16" class="icon-solid"><path d="M5.5 3.2l7 4.8-7 4.8z"/></svg>',
    pause: '<svg viewBox="0 0 16 16"><path d="M6 3.5v9M10 3.5v9"/></svg>',
    stop: '<svg viewBox="0 0 16 16" class="icon-solid"><rect x="4.5" y="4.5" width="7" height="7" rx="1.4"/></svg>',
  };

  const dom = {};
  let miniRing = null;
  let settings = null;
  let lastState = null;
  /** The panel covering the timer, if any: null, 'settings' or 'analytics'. */
  let panel = null;
  let isMini = false;

  const send = (type, payload) => window.flowcus.action(type, payload);

  // ------------------------------------------------------------------ accent

  function accentFor(state) {
    if (state.phase === 'ALARM') return 'alarm';
    if (BREAK_PHASES.includes(state.phase)) return 'break';
    return state.mode === 'FLOW' ? 'flow' : 'pomodoro';
  }

  // ------------------------------------------------------------ mini widget

  /** The one action the mini widget offers, which depends on the phase. */
  function miniPrimary(state) {
    switch (state.phase) {
      case 'IDLE':
        return { icon: 'play', action: 'start', title: 'Start' };
      case 'FOCUS':
        return { icon: 'pause', action: 'pause', title: 'Pause' };
      case 'FOCUS_PAUSED':
        return { icon: 'play', action: 'resume', title: 'Resume' };
      case 'BREAK_PENDING':
        return { icon: 'play', action: 'start-break', title: 'Start break' };
      case 'BREAK':
        return { icon: 'pause', action: 'pause-break', title: 'Pause break' };
      case 'BREAK_PAUSED':
        return { icon: 'play', action: 'resume-break', title: 'Resume break' };
      case 'ALARM':
        return { icon: 'stop', action: 'dismiss-alarm', title: 'Dismiss alarm' };
      case 'WALL':
        return { icon: 'stop', action: 'abandon-wall', title: 'Abandon wall' };
      default:
        return { icon: 'play', action: 'start', title: 'Start' };
    }
  }

  function miniLabel(state) {
    switch (state.phase) {
      case 'ALARM':
        return 'BREAK OVER';
      case 'BREAK_PENDING':
        return 'EARNED';
      case 'BREAK':
      case 'BREAK_PAUSED':
        return 'BREAK';
      case 'FOCUS_PAUSED':
        return 'PAUSED';
      case 'WALL':
        return 'WALL';
      default:
        return state.ring.label;
    }
  }

  function miniMs(state) {
    if (state.phase === 'WALL') return state.wallRemainingMs;
    if (BREAK_PHASES.includes(state.phase)) return state.breakRemainingMs;
    return state.mode === 'POMODORO' ? state.focusRemainingMs : state.focusMs;
  }

  function updateMini(state) {
    dom.miniDigits.textContent = formatClock(miniMs(state));
    dom.miniLabel.textContent = miniLabel(state);
    miniRing.setProgress(state.ring.progress);

    const primary = miniPrimary(state);
    if (dom.miniPrimary.dataset.icon !== primary.icon) {
      dom.miniPrimary.dataset.icon = primary.icon;
      dom.miniPrimary.innerHTML = ICONS[primary.icon];
    }
    dom.miniPrimary.title = primary.title;
    dom.miniPrimary.setAttribute('aria-label', primary.title);
    dom.miniPrimary.dataset.action = primary.action;
  }

  // ------------------------------------------------------------------ routing

  function route(state) {
    const onBreak = BREAK_PHASES.includes(state.phase);
    const onWall = state.phase === 'WALL';

    dom.viewSettings.hidden = panel !== 'settings';
    dom.viewAnalytics.hidden = panel !== 'analytics';
    dom.viewRoom.hidden = panel !== 'room';
    dom.btnRoom.classList.toggle('active', panel === 'room');
    dom.viewWall.hidden = !onWall;
    dom.viewTimer.hidden = panel !== null || onBreak || onWall;
    dom.viewBreak.hidden = panel !== null || !onBreak;
    dom.btnSettings.classList.toggle('active', panel === 'settings');
    dom.btnAnalytics.classList.toggle('active', panel === 'analytics');
  }

  function render(state) {
    lastState = state;
    document.body.dataset.accent = accentFor(state);
    // Lets stylesheets react to the phase -- the wall strips the chrome back.
    document.body.dataset.phase = state.phase;
    // Stylesheets hide what a room takes over (the mode switch) and what a
    // follower may not do. Empty outside a room.
    document.body.dataset.room = state.room ? state.room.role : '';

    // An alarm always wins the screen back from a panel, and the wall clears
    // any panel away so nothing competes with the dot.
    if ((state.phase === 'ALARM' || state.phase === 'WALL') && panel !== null) setPanel(null);

    route(state);
    updateMini(state);

    if (state.phase === 'WALL') {
      Flowcus.wallView.update(state);
    } else if (BREAK_PHASES.includes(state.phase)) {
      Flowcus.breakView.update(state, settings);
    } else {
      Flowcus.timerView.update(state, settings);
    }
  }

  /** Room snapshot from main: redraw the panel, the title tag and the button badge. */
  function renderRoom(view) {
    Flowcus.roomView.update(view);
    const inRoom = view.status === 'active';
    dom.roomTag.hidden = !inRoom;
    dom.roomTag.textContent = inRoom ? view.mnemonic : '';
    dom.btnRoom.classList.toggle('attention', view.isHost && view.pending.length > 0);
  }

  function setSettings(next) {
    settings = next;
    if (lastState) render(lastState);
  }

  /** Switches panels without rendering; callers render once afterwards. */
  function setPanel(next) {
    if (panel === 'analytics' && next !== 'analytics') Flowcus.analyticsView.close();
    panel = next;
    if (panel === 'settings') Flowcus.settingsView.load(settings);
    if (panel === 'analytics') Flowcus.analyticsView.open();
  }

  /** Opens the named panel, or closes it if it is already open. */
  function togglePanel(name) {
    setPanel(panel === name ? null : name);
    if (lastState) render(lastState);
  }

  // ------------------------------------------------------------ global stats

  /** "1.5 Global Focus Hours" under 1000 hours, "12,345 Global Focus Hours" past it. */
  function formatGlobalHours(totalMinutes) {
    const hours = totalMinutes / 60;
    const value = hours >= 1000 ? Math.round(hours).toLocaleString() : hours.toFixed(1);
    return `${value} Global Focus Hours`;
  }

  async function refreshGlobalStats() {
    const totalMinutes = await window.flowcus.globalStats();
    dom.globalStats.hidden = typeof totalMinutes !== 'number';
    if (typeof totalMinutes === 'number') {
      dom.globalStats.textContent = formatGlobalHours(totalMinutes);
    }
  }

  // ---------------------------------------------------------------- keyboard

  function onKeyDown(event) {
    const target = event.target;
    const typing =
      target &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (typing) return;

    if (event.key === 'Escape') {
      if (panel !== null) togglePanel(panel);
      else if (isMini) window.flowcus.window('exit-mini');
      return;
    }

    if (event.key === ' ' || event.code === 'Space') {
      // A focused control keeps Space for itself: a button presses, a chart
      // ignores it. Only an unfocused window treats Space as start/pause.
      if (target.closest('button, [tabindex]')) return;
      event.preventDefault();
      // Space never abandons a wall: one stray keypress must not cost a
      // ten-minute baseline. Abandoning takes a deliberate click.
      if (lastState && lastState.phase !== 'WALL') send(miniPrimary(lastState).action);
      return;
    }

    if (event.key === 'm' || event.key === 'M') {
      window.flowcus.window('toggle-mini');
    }
  }

  // -------------------------------------------------------------------- init

  function cacheDom() {
    dom.viewTimer = document.getElementById('view-timer');
    dom.viewBreak = document.getElementById('view-break');
    dom.viewSettings = document.getElementById('view-settings');
    dom.viewAnalytics = document.getElementById('view-analytics');
    dom.viewWall = document.getElementById('view-wall');
    dom.viewRoom = document.getElementById('view-room');
    dom.btnRoom = document.getElementById('btn-room');
    dom.roomTag = document.getElementById('room-tag');
    dom.globalStats = document.getElementById('global-stats-tag');
    dom.btnSettings = document.getElementById('btn-settings');
    dom.btnAnalytics = document.getElementById('btn-analytics');
    dom.miniDial = document.getElementById('mini-dial');
    dom.miniDigits = document.getElementById('mini-digits');
    dom.miniLabel = document.getElementById('mini-label');
    dom.miniPrimary = document.getElementById('mini-primary');
  }

  function wireChrome() {
    dom.btnSettings.addEventListener('click', () => togglePanel('settings'));
    dom.btnAnalytics.addEventListener('click', () => togglePanel('analytics'));
    dom.btnRoom.addEventListener('click', () => togglePanel('room'));
    document.getElementById('btn-close-settings').addEventListener('click', () =>
      togglePanel('settings')
    );
    document.getElementById('btn-close-analytics').addEventListener('click', () =>
      togglePanel('analytics')
    );
    document.getElementById('btn-mini').addEventListener('click', () =>
      window.flowcus.window('toggle-mini')
    );
    document.getElementById('btn-minimize').addEventListener('click', () =>
      window.flowcus.window('minimize')
    );
    document.getElementById('btn-close').addEventListener('click', () =>
      window.flowcus.window('close')
    );
    document.getElementById('mini-expand').addEventListener('click', () =>
      window.flowcus.window('exit-mini')
    );
    dom.miniPrimary.addEventListener('click', () => send(dom.miniPrimary.dataset.action));

    document.addEventListener('keydown', onKeyDown);
  }

  function subscribe() {
    window.flowcus.onState(render);
    window.flowcus.onSettings(setSettings);
    window.flowcus.onStats((stats) => {
      Flowcus.timerView.setStats(stats);
      // A session just landed; redraw the dashboard in place if it is open.
      Flowcus.analyticsView.refresh();
    });
    window.flowcus.onMini((mini) => {
      isMini = mini;
      document.body.classList.toggle('mini', mini);
    });

    window.flowcus.onAlarm((payload) => {
      if (payload.playing && settings.soundEnabled) {
        Flowcus.alarm.start(payload.volume);
      } else {
        Flowcus.alarm.stop();
      }
    });

    window.flowcus.onChime(() => {
      if (settings.soundEnabled) Flowcus.alarm.chime(settings.alarmVolume * 0.6);
    });

    // The wall hit 0:00 and focus is already running.
    window.flowcus.onTone(() => {
      if (settings.soundEnabled) Flowcus.alarm.bell(settings.alarmVolume * 0.7);
    });
  }

  async function start() {
    cacheDom();

    const boot = await window.flowcus.bootstrap();
    settings = boot.settings;
    isMini = boot.mini;
    document.body.classList.toggle('mini', isMini);

    miniRing = Flowcus.createRing(dom.miniDial, { strokeWidth: 8 });

    Flowcus.timerView.init({ send });
    Flowcus.breakView.init({ send, openReward: (url) => window.flowcus.openReward(url) });
    Flowcus.settingsView.init({
      save: async (next) => {
        settings = await window.flowcus.saveSettings(next);
        if (lastState) render(lastState);
      },
    });
    Flowcus.settingsView.setAbout({ version: boot.version, packaged: boot.packaged });
    Flowcus.wallView.init({ send });
    Flowcus.analyticsView.init();

    const roomController = Flowcus.createRoomController({ onView: renderRoom });
    Flowcus.roomView.init({
      controller: roomController,
      container: dom.viewRoom,
      modal: document.getElementById('room-admit'),
      onClose: () => togglePanel('room'),
    });

    wireChrome();
    subscribe();

    Flowcus.timerView.setStats(boot.stats);
    render(boot.state);
    await roomController.init();

    refreshGlobalStats();
    setInterval(refreshGlobalStats, GLOBAL_STATS_POLL_MS);
  }

  start();
})();

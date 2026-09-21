'use strict';

/**
 * The main timer face: mode switch, ring, digits, controls and the flow
 * earned-so-far preview.
 */
(function () {
  const Flowcus = (window.Flowcus = window.Flowcus || {});
  const { el, formatClock, formatStat } = Flowcus.util;

  const dom = {};
  let ring = null;
  let send = () => {};

  /** Buttons offered for each phase, per mode. */
  function controlsFor(state) {
    // In a study room only the host drives the timer.
    if (state.room && state.room.role === 'follower') return [];
    const flow = state.mode === 'FLOW';

    switch (state.phase) {
      case 'IDLE':
        return [{ label: flow ? 'Start Flow' : 'Start Focus', action: 'start', kind: 'primary' }];
      case 'FOCUS':
        return [
          { label: 'Pause', action: 'pause', kind: 'ghost' },
          {
            label: flow ? 'Stop & Bank Break' : 'Stop',
            action: 'stop',
            kind: flow ? 'primary grow' : 'ghost',
          },
        ];
      case 'FOCUS_PAUSED':
        return [
          { label: 'Resume', action: 'resume', kind: 'primary' },
          {
            label: flow ? 'Stop & Bank Break' : 'Stop',
            action: 'stop',
            kind: 'ghost',
          },
        ];
      default:
        return [];
    }
  }

  function renderControls(state) {
    const buttons = controlsFor(state).map((spec) =>
      el('button', {
        class: 'btn ' + spec.kind,
        text: spec.label,
        onclick: () => send(spec.action),
      })
    );
    dom.controls.replaceChildren.apply(dom.controls, buttons);
  }

  function subLabel(state, settings) {
    if (state.room) {
      const follower = state.room.role === 'follower';
      if (state.phase === 'IDLE') return follower ? 'Waiting for the host to start' : 'Study room · you are the host';
      if (state.phase === 'FOCUS_PAUSED') return 'Paused by the host';
      return 'of ' + formatClock(state.focusTargetMs);
    }
    if (state.phase === 'FOCUS_PAUSED') {
      return state.pausedBySuspend ? 'Paused while your PC was asleep' : 'Paused';
    }
    if (state.phase === 'IDLE' && state.wallInterrupted) {
      return 'Wall interrupted. Start again when ready.';
    }
    if (state.phase === 'IDLE' && settings.wallMethodEnabled) {
      const lead = state.mode === 'POMODORO' ? settings.focusMin + ' min session' : 'Counts up';
      return lead + ' · 10 min wall first';
    }
    if (state.mode === 'POMODORO') {
      if (state.phase === 'IDLE') return settings.focusMin + ' minute session';
      return 'of ' + formatClock(state.focusTargetMs);
    }
    if (state.phase === 'IDLE') return 'Counts up. No alarm until you stop.';
    return 'Counting up';
  }

  /** What the flow preview says you are working toward next. */
  function milestoneNote(minutes) {
    if (minutes < 60) {
      return 'Tier 2 unlocks at 60 min (0.40 per minute)';
    }
    if (minutes < 90) {
      return 'Tier 3 unlocks at 90 min (0.60 per minute, uncapped)';
    }
    return 'Tier 3 unlocked — every minute now earns 36 seconds';
  }

  function renderPreview(state) {
    const showPreview = state.mode === 'FLOW' && state.earned && state.phase !== 'IDLE';
    dom.preview.hidden = !showPreview;
    if (!showPreview) return;

    dom.previewValue.textContent = formatClock(state.earned.totalMs);
    dom.previewFill.style.width = (state.ring.progress * 100).toFixed(1) + '%';
    dom.previewNote.textContent = milestoneNote(state.earned.focusMinutes);
  }

  function renderModeSwitch(state) {
    const locked = state.phase !== 'IDLE';
    for (const button of dom.modeButtons) {
      const isActive = button.dataset.mode === state.mode;
      button.classList.toggle('active', isActive);
      button.disabled = locked;
      button.setAttribute('aria-selected', String(isActive));
    }
    dom.modeThumb.classList.toggle('right', state.mode === 'FLOW');
  }

  function update(state, settings) {
    renderModeSwitch(state);

    const ms = state.mode === 'POMODORO' ? state.focusRemainingMs : state.focusMs;
    dom.digits.textContent = formatClock(ms);
    dom.phaseLabel.textContent = state.phase === 'FOCUS_PAUSED' ? 'PAUSED' : state.ring.label;
    dom.subLabel.textContent = subLabel(state, settings);

    ring.setProgress(state.ring.progress);
    renderPreview(state);
    renderControls(state);
  }

  function setStats(stats) {
    dom.statFocus.textContent = formatStat(stats.focusMs) + ' focused';
    dom.statSessions.textContent =
      stats.sessions + (stats.sessions === 1 ? ' session' : ' sessions');
  }

  function init(context) {
    send = context.send;

    dom.dial = document.getElementById('dial');
    dom.digits = document.getElementById('digits');
    dom.phaseLabel = document.getElementById('phase-label');
    dom.subLabel = document.getElementById('sub-label');
    dom.controls = document.getElementById('timer-controls');
    dom.preview = document.getElementById('flow-preview');
    dom.previewValue = document.getElementById('preview-value');
    dom.previewFill = document.getElementById('preview-bar-fill');
    dom.previewNote = document.getElementById('preview-note');
    dom.statFocus = document.getElementById('stat-focus');
    dom.statSessions = document.getElementById('stat-sessions');
    dom.modeThumb = document.getElementById('mode-thumb');
    dom.modeButtons = Array.from(document.querySelectorAll('.mode-btn'));

    ring = Flowcus.createRing(dom.dial, { strokeWidth: 4 });

    for (const button of dom.modeButtons) {
      button.addEventListener('click', () => send('set-mode', button.dataset.mode));
    }
  }

  Flowcus.timerView = { init, update, setStats };
})();

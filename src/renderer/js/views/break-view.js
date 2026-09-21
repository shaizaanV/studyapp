'use strict';

/**
 * The break screen: what you earned, the arithmetic behind it, the reward
 * links, and the countdown once the break is running.
 */
(function () {
  const Flowcus = (window.Flowcus = window.Flowcus || {});
  const { el, formatClock } = Flowcus.util;

  const dom = {};
  let send = () => {};
  let openReward = () => {};

  /** Kicker, big number and note for each break phase. */
  function headFor(state) {
    switch (state.phase) {
      case 'BREAK_PENDING':
        return {
          kicker: 'BREAK EARNED',
          value: formatClock(state.breakTotalMs),
          note:
            state.earnedKind === 'FLOW'
              ? 'Banked from your flow session. Take it now or skip it.'
              : 'Step away from the screen.',
        };
      case 'BREAK':
        return {
          kicker: 'BREAK REMAINING',
          value: formatClock(state.breakRemainingMs),
          note: 'Alarm sounds when this hits zero.',
        };
      case 'BREAK_PAUSED':
        return {
          kicker: 'BREAK PAUSED',
          value: formatClock(state.breakRemainingMs),
          note: 'Paused.',
        };
      case 'ALARM':
        return {
          kicker: 'BREAK OVER',
          value: '0:00',
          note: 'Phone out of reach. Back to work.',
        };
      default:
        return { kicker: 'BREAK', value: '0:00', note: '' };
    }
  }

  function controlsFor(state) {
    // A room follower cannot end the shared break, but can silence its own alarm.
    if (state.room && state.room.role === 'follower') {
      return state.phase === 'ALARM'
        ? [{ label: 'Silence Alarm', action: 'dismiss-alarm', kind: 'primary grow' }]
        : [];
    }
    switch (state.phase) {
      case 'BREAK_PENDING':
        return [
          { label: 'Start Break', action: 'start-break', kind: 'primary grow' },
          { label: 'Skip', action: 'skip-break', kind: 'quiet' },
        ];
      case 'BREAK':
        return [
          { label: 'Pause', action: 'pause-break', kind: 'ghost' },
          { label: 'End Break', action: 'skip-break', kind: 'ghost' },
        ];
      case 'BREAK_PAUSED':
        return [
          { label: 'Resume', action: 'resume-break', kind: 'primary' },
          { label: 'End Break', action: 'skip-break', kind: 'ghost' },
        ];
      case 'ALARM':
        return [
          { label: 'Continue Session', action: 'continue-session', kind: 'primary grow' },
          { label: 'End Session', action: 'dismiss-alarm', kind: 'ghost' },
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

  function renderRewards(settings) {
    const rewards = settings.rewards || [];

    if (rewards.length === 0) {
      dom.rewardGrid.replaceChildren(
        el('div', {
          class: 'rewards-empty',
          text: 'No links yet — add some in Settings.',
        })
      );
      return;
    }

    const buttons = rewards.map((reward) =>
      el('button', {
        class: 'reward-btn',
        text: reward.label,
        title: reward.url,
        onclick: () => openReward(reward.url),
      })
    );
    dom.rewardGrid.replaceChildren.apply(dom.rewardGrid, buttons);
  }

  function update(state, settings) {
    const head = headFor(state);
    dom.kicker.textContent = head.kicker;
    dom.value.textContent = head.value;
    dom.note.textContent = head.note;
    dom.head.classList.toggle('alarming', state.phase === 'ALARM');

    Flowcus.renderBreakdown(dom.breakdown, state.earned, state.breakTotalMs);
    renderRewards(settings);
    renderControls(state);
  }

  function init(context) {
    send = context.send;
    openReward = context.openReward;

    dom.head = document.querySelector('#view-break .break-head');
    dom.kicker = document.getElementById('break-kicker');
    dom.value = document.getElementById('break-value');
    dom.note = document.getElementById('break-note');
    dom.breakdown = document.getElementById('breakdown-box');
    dom.rewardGrid = document.getElementById('reward-grid');
    dom.controls = document.getElementById('break-controls');
  }

  Flowcus.breakView = { init, update };
})();

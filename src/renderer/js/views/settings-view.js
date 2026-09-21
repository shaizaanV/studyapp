'use strict';

/**
 * Settings: durations, alarm behaviour, and the reward-link list that the
 * break screen renders under the breakdown.
 */
(function () {
  const Flowcus = (window.Flowcus = window.Flowcus || {});
  const { el } = Flowcus.util;

  /** How long the "test alarm" button rings for. */
  const TEST_ALARM_MS = 2400;

  const dom = {};
  let save = () => {};
  let current = null;
  let rewards = [];
  let testTimer = null;

  const ICONS = {
    up: '<svg viewBox="0 0 16 16"><path d="M8 12V4M4.5 7.5L8 4l3.5 3.5"/></svg>',
    down: '<svg viewBox="0 0 16 16"><path d="M8 4v8M4.5 8.5L8 12l3.5-3.5"/></svg>',
    remove: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  };

  function iconButton(icon, className, title, onClick, disabled) {
    const button = el('button', {
      class: 'icon-btn ' + className,
      title: title,
      'aria-label': title,
      disabled: disabled || null,
      onclick: onClick,
    });
    button.innerHTML = ICONS[icon];
    return button;
  }

  function isValidUrl(url) {
    try {
      const protocol = new URL(String(url)).protocol;
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  }

  /** Reads the form back into a settings object and persists it. */
  function commit() {
    const settings = {
      focusMin: Number(dom.focus.value),
      breakMin: Number(dom.break.value),
      autoStartBreak: dom.autostart.checked,
      wallMethodEnabled: dom.wall.checked,
      shareAnonymousStats: dom.shareStats.checked,
      soundEnabled: dom.sound.checked,
      alarmVolume: Number(dom.volume.value) / 100,
      // Rows still being typed are held locally and simply not persisted yet.
      rewards: rewards.filter((reward) => reward.label.trim() && isValidUrl(reward.url)),
    };
    save(settings);
  }

  function rewardRow(reward, index) {
    const labelInput = el('input', {
      type: 'text',
      class: 'label',
      value: reward.label,
      placeholder: 'Name',
      maxlength: '40',
    });
    labelInput.addEventListener('input', () => {
      reward.label = labelInput.value;
    });
    labelInput.addEventListener('change', commit);

    const urlInput = el('input', {
      type: 'url',
      class: 'url',
      value: reward.url,
      placeholder: 'https://www.youtube.com/@channel',
    });

    const row = el('div', { class: 'reward-row' });

    urlInput.addEventListener('input', () => {
      reward.url = urlInput.value;
      // Flag a bad link as you type, but never delete the row out from under you.
      row.classList.toggle('invalid', urlInput.value.length > 0 && !isValidUrl(urlInput.value));
    });
    urlInput.addEventListener('change', commit);

    const actions = el('div', { class: 'row-actions' }, [
      iconButton('up', 'move', 'Move up', () => move(index, -1), index === 0),
      iconButton('down', 'move', 'Move down', () => move(index, 1), index === rewards.length - 1),
      iconButton('remove', 'remove', 'Remove', () => remove(index)),
    ]);

    row.append(labelInput, urlInput, actions);
    if (reward.url && !isValidUrl(reward.url)) row.classList.add('invalid');
    return row;
  }

  function move(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= rewards.length) return;
    const [item] = rewards.splice(index, 1);
    rewards.splice(target, 0, item);
    renderRewardEditor();
    commit();
  }

  function remove(index) {
    rewards.splice(index, 1);
    renderRewardEditor();
    commit();
  }

  function addReward() {
    rewards.push({
      id: 'r-' + Date.now().toString(36),
      label: '',
      url: '',
    });
    renderRewardEditor();
    const inputs = dom.rewardEditor.querySelectorAll('.reward-row input.label');
    const last = inputs[inputs.length - 1];
    if (last) last.focus();
  }

  function renderRewardEditor() {
    dom.rewardEditor.replaceChildren.apply(dom.rewardEditor, rewards.map(rewardRow));
  }

  function testAlarm() {
    if (testTimer) {
      clearTimeout(testTimer);
      testTimer = null;
      Flowcus.alarm.stop();
      dom.testAlarm.textContent = 'Test alarm sound';
      return;
    }
    Flowcus.alarm.start(Number(dom.volume.value) / 100);
    dom.testAlarm.textContent = 'Stop';
    testTimer = setTimeout(() => {
      Flowcus.alarm.stop();
      dom.testAlarm.textContent = 'Test alarm sound';
      testTimer = null;
    }, TEST_ALARM_MS);
  }

  /** Fills the form. Called when settings are opened, not on every keystroke. */
  function load(settings) {
    current = settings;
    dom.focus.value = settings.focusMin;
    dom.break.value = settings.breakMin;
    dom.autostart.checked = settings.autoStartBreak;
    dom.wall.checked = settings.wallMethodEnabled;
    dom.shareStats.checked = settings.shareAnonymousStats;
    dom.sound.checked = settings.soundEnabled;
    dom.volume.value = Math.round(settings.alarmVolume * 100);
    dom.volumeReadout.textContent = Math.round(settings.alarmVolume * 100) + '%';

    rewards = (settings.rewards || []).map((reward) => ({ ...reward }));
    renderRewardEditor();
  }

  function setAbout(info) {
    dom.about.replaceChildren(
      el('div', { text: 'Flowcus ' + info.version }),
      el('div', {
        text: info.packaged
          ? 'Break-end alarm: looping tone, alarm toast, taskbar flash and window focus.'
          : 'Running unpackaged — Windows toasts need the installed build to appear.',
      })
    );
  }

  function init(context) {
    save = context.save;

    dom.focus = document.getElementById('set-focus');
    dom.break = document.getElementById('set-break');
    dom.autostart = document.getElementById('set-autostart');
    dom.wall = document.getElementById('set-wall');
    dom.shareStats = document.getElementById('set-share-stats');
    dom.sound = document.getElementById('set-sound');
    dom.volume = document.getElementById('set-volume');
    dom.volumeReadout = document.getElementById('volume-readout');
    dom.testAlarm = document.getElementById('btn-test-alarm');
    dom.rewardEditor = document.getElementById('reward-editor');
    dom.about = document.getElementById('about');

    for (const input of [dom.focus, dom.break]) {
      input.addEventListener('change', commit);
    }
    for (const input of [dom.autostart, dom.sound, dom.wall, dom.shareStats]) {
      input.addEventListener('change', commit);
    }

    dom.volume.addEventListener('input', () => {
      dom.volumeReadout.textContent = dom.volume.value + '%';
    });
    dom.volume.addEventListener('change', commit);

    dom.testAlarm.addEventListener('click', testAlarm);
    document.getElementById('btn-add-reward').addEventListener('click', addReward);
  }

  Flowcus.settingsView = { init, load, setAbout };
})();

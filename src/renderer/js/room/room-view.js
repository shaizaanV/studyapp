'use strict';

/**
 * The study room panel and the admission dialog.
 *
 * It draws the view snapshot main publishes and turns clicks into controller
 * calls. It never touches RTCPeerConnection and holds no room state of its own
 * beyond which join step is on screen. Joining is one short code; the old
 * copy-paste handshake lives under "Advanced" for when the relay is unreachable.
 *
 * The skeleton is built once and updated in place, so a chat draft or a pasted
 * code survives the many state updates a live room produces.
 */
(function () {
  const Flowcus = (window.Flowcus = window.Flowcus || {});
  const { el } = Flowcus.util;

  const NAME_KEY = 'flowcus-room-name';

  const ui = {};
  let controller = null;
  let latest = null;
  let pendingBaseline = { at: 0, seconds: {} };

  const storedName = () => {
    try {
      return localStorage.getItem(NAME_KEY) || '';
    } catch {
      return '';
    }
  };
  const rememberName = (name) => {
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch {
      /* private mode or blocked storage: the name just is not remembered */
    }
  };

  const say = (node, text, kind) => {
    node.textContent = text || '';
    node.dataset.kind = kind || '';
    node.hidden = !text;
  };

  /** Copies text and flashes the button. Falls back to selecting the field. */
  async function copyText(text, button, field) {
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      if (field) {
        field.focus();
        field.select();
      }
    }
    const label = button.dataset.label || button.textContent;
    button.dataset.label = label;
    button.textContent = copied ? 'Copied' : 'Select and copy';
    setTimeout(() => {
      button.textContent = label;
    }, 1600);
  }

  const field = (label, control, hint) =>
    el('label', { class: 'room-field' }, [
      el('span', { class: 'field-label', text: label }),
      control,
      hint ? el('span', { class: 'field-hint', text: hint }) : null,
    ]);

  const codeBox = (attrs) => el('textarea', { class: 'room-code', rows: 3, spellcheck: 'false', ...attrs });

  // ------------------------------------------------------------- idle screen

  const PHASE_TEXT = { checking: 'Checking the code…', waiting: 'Asking the room…', connecting: 'Connecting…' };

  function buildIdle() {
    ui.name = el('input', { type: 'text', id: 'room-name', maxlength: 40, placeholder: 'Your name', autocomplete: 'off' });
    ui.name.value = storedName();

    ui.notice = el('div', { class: 'room-banner', id: 'room-notice', role: 'status', hidden: true });
    ui.idleError = el('p', { class: 'room-note', hidden: true });

    ui.createBtn = el('button', { class: 'btn primary', id: 'room-create', text: 'Create a room', onclick: onCreate });

    ui.codeInput = el('input', {
      type: 'text', id: 'room-code-input', class: 'code-input', maxlength: 8, placeholder: 'ABC-123',
      autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Room code',
    });
    ui.codeInput.addEventListener('input', onCodeTyped);
    ui.codeInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') onJoinCode();
    });
    ui.joinBtn = el('button', { class: 'btn ghost', id: 'room-join', text: 'Join', onclick: onJoinCode });
    ui.joinNote = el('p', { class: 'room-note', id: 'room-join-note', hidden: true });

    // Advanced: the original copy-paste handshake, for when the relay cannot be reached.
    ui.inviteBox = codeBox({ readonly: true, placeholder: 'Your invite appears here' });
    ui.copyInvite = el('button', { class: 'btn primary', text: 'Copy Invite', onclick: onCopyInvite });
    ui.replyBox = codeBox({ placeholder: 'Paste the reply here' });
    ui.connectBtn = el('button', { class: 'btn ghost', text: 'Connect', onclick: onConnect });
    ui.advNote = el('p', { class: 'room-note', hidden: true });

    ui.joinFlow = el('div', { class: 'room-flow' }, [
      el('div', { class: 'room-step' }, [
        el('div', { class: 'micro', text: '1 · Send your invite' }),
        el('p', { class: 'room-help', text: 'Copy it and send it to someone already in the room, in any chat app.' }),
        ui.inviteBox,
        el('div', { class: 'room-row' }, [ui.copyInvite]),
      ]),
      el('div', { class: 'room-step' }, [
        el('div', { class: 'micro', text: '2 · Paste their reply' }),
        el('p', { class: 'room-help', text: 'They send back a reply. Paste it here to connect.' }),
        ui.replyBox,
        el('div', { class: 'room-row' }, [ui.connectBtn]),
      ]),
      ui.advNote,
    ]);

    ui.turnUrl = el('input', { type: 'text', placeholder: 'turn:relay.example.com:3478', autocomplete: 'off' });
    ui.turnUser = el('input', { type: 'text', placeholder: 'Username', autocomplete: 'off' });
    ui.turnPass = el('input', { type: 'text', placeholder: 'Credential', autocomplete: 'off' });
    ui.turnSave = el('button', { class: 'btn ghost', text: 'Save relay', onclick: onSaveTurn });
    ui.turnNote = el('p', { class: 'room-note', hidden: true });

    ui.idle = el('section', { class: 'room-section' }, [
      el('h2', { class: 'section-title', text: 'Study room' }),
      el('p', {
        class: 'room-lede',
        text: 'Study together over a direct peer-to-peer link. Start a room and share its short code, or enter a code to join one.',
      }),
      ui.notice,
      field('Your name', ui.name),
      el('div', { class: 'room-row' }, [ui.createBtn]),
      el('div', { class: 'room-or', text: 'or join with a code' }),
      el('div', { class: 'room-row room-join-row' }, [ui.codeInput, ui.joinBtn]),
      ui.joinNote,
      ui.idleError,
      el('details', { class: 'room-details', id: 'room-advanced' }, [
        el('summary', { text: 'Advanced · join without a code' }),
        el('p', {
          class: 'room-help',
          text: 'If joining by code is not working (no connection to the code service), you can still join by trading an invite and a reply in any chat app.',
        }),
        ui.joinFlow,
        el('div', { class: 'micro', text: 'Relay server (optional)' }),
        el('p', {
          class: 'room-help',
          text: 'Some networks block direct connections. A TURN relay you have credentials for lets those connect. Leave empty to use STUN only.',
        }),
        field('Relay URL', ui.turnUrl),
        field('Username', ui.turnUser),
        field('Credential', ui.turnPass),
        el('div', { class: 'room-row' }, [ui.turnSave]),
        ui.turnNote,
      ]),
    ]);
  }

  /** Keeps the box uppercase and dashed as K7Q-X2M while the person types. */
  function onCodeTyped() {
    const raw = ui.codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    ui.codeInput.value = raw.length > 3 ? `${raw.slice(0, 3)}-${raw.slice(3)}` : raw;
    say(ui.joinNote, '');
  }

  /** A flowcus://join/CODE link or QR landed: fill the box, never join on its own. */
  function prefillCode(code) {
    if (!ui.codeInput) return;
    ui.codeInput.value = code;
    onCodeTyped();
    ui.codeInput.focus();
  }

  let joining = false;

  function setPhase(phase) {
    if (PHASE_TEXT[phase] && joining) say(ui.joinNote, PHASE_TEXT[phase], 'info');
  }

  function nameOrError() {
    const name = ui.name.value.replace(/\s+/g, ' ').trim();
    if (!name) {
      say(ui.idleError, 'Enter a name first.', 'error');
      ui.name.focus();
      return null;
    }
    rememberName(name);
    return name;
  }

  async function onCreate() {
    const name = nameOrError();
    if (!name) return;
    ui.createBtn.disabled = true;
    const result = await controller.create(name);
    ui.createBtn.disabled = false;
    say(ui.idleError, result.ok ? '' : result.error, 'error');
  }

  async function onJoinCode() {
    const name = nameOrError();
    if (!name) return;
    if (ui.codeInput.value.replace(/-/g, '').length < 6) {
      say(ui.joinNote, 'Enter the 6-character room code.', 'error');
      ui.codeInput.focus();
      return;
    }
    say(ui.idleError, '');
    joining = true;
    ui.joinBtn.disabled = true;
    ui.codeInput.disabled = true;
    say(ui.joinNote, PHASE_TEXT.checking, 'info');
    const result = await controller.joinWithCode(ui.codeInput.value, name);
    joining = false;
    ui.joinBtn.disabled = false;
    ui.codeInput.disabled = false;
    if (result.ok) {
      say(ui.joinNote, 'Connecting…', 'info');
    } else {
      say(ui.joinNote, result.error, 'error');
      ui.codeInput.focus();
    }
  }

  async function onCopyInvite() {
    const name = nameOrError();
    if (!name) return;
    ui.copyInvite.disabled = true;
    say(ui.advNote, 'Preparing your invite…', 'info');
    const result = await controller.makeInvite(name);
    ui.copyInvite.disabled = false;
    if (!result.ok) {
      say(ui.advNote, result.error, 'error');
      return;
    }
    say(ui.advNote, 'Waiting for their reply. Paste it below, then Connect. This invite is good for 10 minutes.', 'info');
    ui.inviteBox.value = result.invite;
    copyText(result.invite, ui.copyInvite, ui.inviteBox);
  }

  async function onConnect() {
    const text = ui.replyBox.value.trim();
    if (!text) {
      say(ui.advNote, 'Paste the reply first.', 'error');
      return;
    }
    ui.connectBtn.disabled = true;
    const result = await controller.useReply(text);
    ui.connectBtn.disabled = false;
    say(ui.advNote, result.ok ? 'Connecting…' : result.error, result.ok ? 'info' : 'error');
  }

  async function onSaveTurn() {
    const saved = await controller.setTurn({
      url: ui.turnUrl.value,
      username: ui.turnUser.value,
      credential: ui.turnPass.value,
    });
    ui.turnUrl.value = saved.url;
    say(
      ui.turnNote,
      saved.url ? 'Relay saved. It is used for connections you start from now on.' : 'Relay cleared. Only STUN is used.',
      'info'
    );
  }

  // --------------------------------------------------------- joining screen

  function buildJoining() {
    ui.joiningNote = el('p', { class: 'room-lede', text: 'Connected. Waiting to be let in…' });
    ui.joining = el('section', { class: 'room-section', hidden: true }, [
      el('h2', { class: 'section-title', text: 'Joining' }),
      ui.joiningNote,
      el('div', { class: 'room-row' }, [
        el('button', { class: 'btn ghost', text: 'Cancel', onclick: () => controller.leave() }),
      ]),
    ]);
  }

  // ------------------------------------------------------------ room screen

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /** Draws the join link as an SVG QR code. Presentation attributes only: the page's CSP forbids inline styles. */
  function renderQr(link) {
    const { size, modules } = window.QR.encode(link);
    const quiet = 2;
    let path = '';
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) if (modules[y][x]) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${size + quiet * 2} ${size + quiet * 2}`);
    svg.setAttribute('class', 'room-qr-svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'QR code for the room link');
    const bg = document.createElementNS(SVG_NS, 'rect');
    bg.setAttribute('width', size + quiet * 2);
    bg.setAttribute('height', size + quiet * 2);
    bg.setAttribute('fill', '#ffffff');
    const dark = document.createElementNS(SVG_NS, 'path');
    dark.setAttribute('d', path);
    dark.setAttribute('fill', '#000000');
    svg.append(bg, dark);
    return svg;
  }

  /** A button that must be pressed twice within three seconds: for kick and ban. */
  function confirmButton(label, confirmLabel, action, attrs) {
    const button = el('button', { class: 'btn-mini danger', text: label, ...attrs });
    let timer = null;
    button.addEventListener('click', () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        button.textContent = label;
        action();
        return;
      }
      button.textContent = confirmLabel;
      timer = setTimeout(() => {
        timer = null;
        button.textContent = label;
      }, 3000);
    });
    return button;
  }

  function buildActive() {
    ui.mnemonic = el('div', { class: 'room-mnemonic' });
    ui.roomSub = el('div', { class: 'room-sub' });

    ui.code = el('div', { class: 'room-join-code', id: 'room-code', 'aria-live': 'polite' });
    ui.codeNote = el('p', { class: 'room-note', id: 'room-code-note', hidden: true });
    ui.copyCode = el('button', { class: 'btn ghost', id: 'room-copy-code', text: 'Copy code', onclick: () => copyText(latest.relay.code, ui.copyCode) });
    ui.copyLink = el('button', { class: 'btn ghost', id: 'room-copy-link', text: 'Copy link', onclick: () => copyText(latest.relay.link, ui.copyLink) });
    ui.qrToggle = el('button', { class: 'btn ghost', id: 'room-qr-toggle', text: 'QR', onclick: onToggleQr });
    ui.rotate = el('button', { class: 'btn ghost', id: 'room-rotate', text: 'New code', onclick: onRotate });
    ui.qr = el('div', { class: 'room-qr', id: 'room-qr', hidden: true });
    ui.codeRow = el('div', { class: 'room-row room-code-actions' }, [ui.copyCode, ui.copyLink, ui.qrToggle, ui.rotate]);
    ui.codeBlock = el('div', { class: 'room-code-block' }, [
      el('div', { class: 'micro', text: 'Room code' }),
      ui.code,
      ui.codeNote,
      ui.codeRow,
      ui.qr,
    ]);

    ui.askFirst = el('input', { type: 'checkbox', id: 'room-ask-first' });
    ui.askFirst.addEventListener('change', () => controller.setAdmission(ui.askFirst.checked ? 'ask' : 'open'));
    ui.askRow = el('label', { class: 'room-toggle' }, [
      ui.askFirst,
      el('span', { text: 'Ask me before people join' }),
    ]);

    ui.members = el('ul', { class: 'room-members' });
    ui.modNote = el('p', { class: 'room-note', hidden: true });
    ui.waiting = el('div', { class: 'room-waiting', hidden: true });

    ui.inviteIn = codeBox({ placeholder: 'Paste their invite here' });
    ui.makeReply = el('button', { class: 'btn ghost', text: 'Create Reply', onclick: onMakeReply });
    ui.replyOut = codeBox({ readonly: true, hidden: true });
    ui.copyReply = el('button', { class: 'btn primary', text: 'Copy Reply', hidden: true, onclick: onCopyReply });
    ui.addNote = el('p', { class: 'room-note', hidden: true });

    ui.chatLog = el('div', { class: 'chat-log', role: 'log', 'aria-live': 'polite' });
    ui.chatInput = el('input', { type: 'text', class: 'chat-input', maxlength: 500, placeholder: 'Message the room', autocomplete: 'off' });
    ui.chatInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') onSendChat();
    });
    ui.chatError = el('p', { class: 'room-note', hidden: true });

    ui.endRoom = confirmButton('End room for everyone', 'Press again to end', onEndRoom, { id: 'room-end', class: 'btn-mini danger room-end' });

    ui.active = el('section', { class: 'room-section', hidden: true }, [
      el('div', { class: 'room-head' }, [
        el('div', { class: 'micro', text: 'Room' }),
        ui.mnemonic,
        ui.roomSub,
      ]),
      ui.codeBlock,
      ui.askRow,
      ui.members,
      ui.modNote,
      ui.waiting,
      el('details', { class: 'room-details', id: 'room-add-manual' }, [
        el('summary', { text: 'Advanced · add someone manually' }),
        el('p', { class: 'room-help', text: 'Paste the invite they sent you, then send back the reply.' }),
        ui.inviteIn,
        el('div', { class: 'room-row' }, [ui.makeReply]),
        ui.replyOut,
        el('div', { class: 'room-row' }, [ui.copyReply]),
        ui.addNote,
      ]),
      el('div', { class: 'micro room-chat-title', text: 'Chat' }),
      ui.chatLog,
      el('div', { class: 'chat-compose' }, [
        ui.chatInput,
        el('button', { class: 'btn primary chat-send', text: 'Send', onclick: onSendChat }),
      ]),
      ui.chatError,
      el('div', { class: 'room-row room-leave' }, [
        el('button', { class: 'btn ghost', id: 'room-leave', text: 'Leave room', onclick: () => controller.leave() }),
        ui.endRoom,
      ]),
    ]);
  }

  let shownQrLink = '';

  function onToggleQr() {
    if (!latest || !latest.relay.link) return;
    ui.qr.hidden = !ui.qr.hidden;
    if (!ui.qr.hidden) drawQr(latest.relay.link);
  }

  function drawQr(link) {
    if (shownQrLink === link && ui.qr.firstChild) return;
    shownQrLink = link;
    ui.qr.replaceChildren(renderQr(link), el('p', { class: 'room-help', text: 'Scan to fill in the room code.' }));
  }

  async function onRotate() {
    const result = await controller.rotate();
    say(ui.modNote, result.ok ? 'New code issued. The old one no longer works.' : result.error, result.ok ? 'info' : 'error');
  }

  async function onEndRoom() {
    const result = await controller.endRoom();
    if (!result.ok) say(ui.modNote, result.error, 'error');
  }

  async function moderate(action, member) {
    const result = await controller.mod(action, member.key);
    say(ui.modNote, result.ok ? '' : result.error, 'error');
  }

  async function onMakeReply() {
    const text = ui.inviteIn.value.trim();
    if (!text) {
      say(ui.addNote, 'Paste an invite first.', 'error');
      return;
    }
    ui.makeReply.disabled = true;
    const result = await controller.admit(text);
    ui.makeReply.disabled = false;
    if (!result.ok) {
      say(ui.addNote, result.error, 'error');
      ui.replyOut.hidden = true;
      ui.copyReply.hidden = true;
      return;
    }
    ui.replyOut.value = result.reply;
    ui.replyOut.hidden = false;
    ui.copyReply.hidden = false;
    say(
      ui.addNote,
      `Send this reply to ${result.name}. ${latest && latest.isHost ? 'You will be asked to approve them.' : 'The host will be asked to approve them.'}`,
      'info'
    );
    ui.inviteIn.value = '';
  }

  function onCopyReply() {
    copyText(ui.replyOut.value, ui.copyReply, ui.replyOut);
  }

  async function onSendChat() {
    const text = ui.chatInput.value.trim();
    if (!text) return;
    const result = await controller.chat(text);
    if (result.ok) {
      ui.chatInput.value = '';
      say(ui.chatError, '');
    } else {
      say(ui.chatError, result.error, 'error');
    }
  }

  /** Mods act on plain members; only the host acts on mods; nobody acts on the host or themselves. */
  const canAct = (view, member) =>
    !member.isSelf && !member.isHost && (view.selfRole === 'host' || (view.selfRole === 'mod' && member.role === 'member'));

  function memberActions(view, member) {
    if (!canAct(view, member)) return null;
    const buttons = [
      el('button', {
        class: 'btn-mini', 'data-action': member.muted ? 'unmute' : 'mute', 'data-key': member.key,
        text: member.muted ? 'Unmute' : 'Mute', onclick: () => moderate(member.muted ? 'unmute' : 'mute', member),
      }),
    ];
    if (member.role === 'member') {
      buttons.push(el('button', {
        class: 'btn-mini', 'data-action': 'promote', 'data-key': member.key, text: 'Make mod', onclick: () => moderate('promote', member),
      }));
    } else if (view.selfRole === 'host') {
      buttons.push(el('button', {
        class: 'btn-mini', 'data-action': 'demote', 'data-key': member.key, text: 'Remove mod', onclick: () => moderate('demote', member),
      }));
    }
    buttons.push(confirmButton('Kick', 'Kick?', () => moderate('kick', member), { 'data-action': 'kick', 'data-key': member.key }));
    buttons.push(confirmButton('Ban', 'Ban?', () => moderate('ban', member), { 'data-action': 'ban', 'data-key': member.key }));
    return el('div', { class: 'member-actions' }, buttons);
  }

  function renderMembers(view) {
    ui.members.replaceChildren(
      ...view.members.map((member) =>
        el('li', { class: 'room-member' + (member.connected ? '' : ' offline'), 'data-key': member.key }, [
          el('div', { class: 'member-line' }, [
            el('span', { class: 'member-dot', 'aria-hidden': 'true' }),
            el('span', { class: 'member-name', text: member.name }),
            member.isSelf ? el('span', { class: 'member-tag', text: 'You' }) : null,
            member.isHost ? el('span', { class: 'member-tag host', text: 'Host' }) : null,
            member.role === 'mod' ? el('span', { class: 'member-tag host', text: 'Mod' }) : null,
            member.muted ? el('span', { class: 'member-tag', text: 'Muted' }) : null,
            !member.connected && !member.isSelf ? el('span', { class: 'member-tag', text: 'Connecting' }) : null,
          ]),
          memberActions(view, member),
        ])
      )
    );
  }

  /** The code, its buttons and the relay-state messages. */
  function renderCode(view) {
    const relay = view.relay;
    const controller_ = view.selfRole !== 'member';
    const hasCode = relay.state === 'up' && Boolean(relay.code);
    ui.code.textContent = hasCode ? relay.code : '';
    ui.code.hidden = !hasCode;
    ui.codeRow.hidden = !hasCode;
    ui.rotate.hidden = !controller_;
    if (!hasCode) ui.qr.hidden = true;

    let note = '';
    if (relay.state === 'connecting') note = 'Getting your room code…';
    else if (relay.state === 'down') note = 'Room codes are unavailable right now. Use "Advanced" below to add people with an invite.';
    else if (relay.state === 'off') note = 'Room codes are not set up in this build. Use "Advanced" below to add people with an invite.';
    else if (relay.state === 'up' && !relay.code) note = 'Reconnecting to the code service…';
    say(ui.codeNote, note, relay.state === 'down' ? 'error' : 'info');

    ui.askRow.hidden = !controller_;
    ui.askFirst.checked = view.admission === 'ask';
    ui.endRoom.hidden = !view.isHost;
    if (hasCode && !ui.qr.hidden) drawQr(relay.link);
  }

  function renderChat(view) {
    const nearBottom = ui.chatLog.scrollHeight - ui.chatLog.scrollTop - ui.chatLog.clientHeight < 40;
    ui.chatLog.replaceChildren(
      ...view.chat.map((message) =>
        el('div', { class: 'chat-line' + (message.self ? ' self' : '') }, [
          el('span', { class: 'chat-name', text: message.self ? 'You' : message.name }),
          el('span', { class: 'chat-text', text: message.text }),
        ])
      )
    );
    if (nearBottom) ui.chatLog.scrollTop = ui.chatLog.scrollHeight;
  }

  function renderWaiting(view) {
    const mine = view.pending.filter((entry) => entry.introducedByMe);
    ui.waiting.hidden = mine.length === 0 || view.isHost;
    ui.waiting.textContent = mine.map((entry) => `Waiting for the host to approve ${entry.name}…`).join(' ');
  }

  // ------------------------------------------------------- admission dialog

  function buildModal(container) {
    ui.modal = container;
    ui.modalCard = el('div', { class: 'admit-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Admit to room' });
    container.append(ui.modalCard);
  }

  function renderModal(view) {
    const entries = view.isHost ? view.pending : [];
    ui.modal.hidden = entries.length === 0;
    if (entries.length === 0) return;

    const entry = entries[0];
    pendingBaseline = { at: Date.now(), seconds: Object.fromEntries(entries.map((e) => [e.key, e.secondsLeft])) };

    ui.admitTimer = el('span', { class: 'admit-timer' });
    ui.modalCard.replaceChildren(
      el('div', { class: 'micro', text: entries.length > 1 ? `Join request · 1 of ${entries.length}` : 'Join request' }),
      el('div', { class: 'admit-name', text: entry.name }),
      el('p', {
        class: 'admit-by',
        text: entry.introducerKey === view.selfKey
          ? 'Joined through you.'
          : `Introduced by ${entry.introducerName}.`,
      }),
      el('details', { class: 'admit-verify' }, [
        el('summary', { text: 'Verify who they are (optional)' }),
        el('div', { class: 'admit-fingerprint', text: entry.fingerprint }),
        el('p', {
          class: 'room-help',
          text: 'Ask them to read out their fingerprint. It should match exactly.',
        }),
      ]),
      el('div', { class: 'room-row' }, [
        el('button', { class: 'btn ghost', text: 'Decline', onclick: () => controller.deny(entry.key) }),
        el('button', { class: 'btn primary', text: 'Admit', onclick: () => controller.approve(entry.key) }),
      ]),
      ui.admitTimer
    );
    tickModal();
  }

  function tickModal() {
    if (!latest || !ui.admitTimer || ui.modal.hidden) return;
    const entry = latest.pending[0];
    if (!entry) return;
    const base = pendingBaseline.seconds[entry.key] ?? entry.secondsLeft;
    const left = Math.max(0, base - Math.floor((Date.now() - pendingBaseline.at) / 1000));
    ui.admitTimer.textContent = `Expires in ${left}s`;
  }

  // ---------------------------------------------------------------- routing

  function update(view) {
    latest = view;
    const status = view.status;
    // A join in progress stays on the start screen, with its copy-paste steps
    // open, until a reply is pasted; only then does it become the waiting screen.
    const waiting = status === 'joining' && view.waitingForHost;
    ui.idle.hidden = !(status === 'idle' || (status === 'joining' && !waiting));
    ui.joining.hidden = !waiting;
    ui.active.hidden = status !== 'active';

    if (status === 'idle') say(ui.idleError, view.error, 'error');
    ui.notice.hidden = !(status === 'idle' && view.notice);
    ui.notice.textContent = view.notice ? view.notice.text : '';

    if (status === 'active') {
      ui.mnemonic.textContent = view.mnemonic;
      ui.roomSub.textContent =
        `${view.members.length} of ${view.maxPeers} · ${{ host: 'You are the host', mod: 'You are a moderator' }[view.selfRole] || 'You are a member'}`;
      renderCode(view);
      renderMembers(view);
      renderChat(view);
      renderWaiting(view);
    }
    renderModal(view);
  }

  function init({ controller: roomController, container, modal, onClose }) {
    controller = roomController;
    buildIdle();
    buildJoining();
    buildActive();
    buildModal(modal);
    container.append(
      el('div', { class: 'room-scroll' }, [ui.idle, ui.joining, ui.active]),
      el('section', { class: 'controls' }, [
        el('button', { class: 'btn primary full', id: 'btn-close-room', text: 'Done', onclick: onClose }),
      ])
    );
    setInterval(tickModal, 1000);

    controller.getTurn().then((turn) => {
      ui.turnUrl.value = turn.url;
      ui.turnUser.value = turn.username;
      ui.turnPass.value = turn.credential;
    });
  }

  Flowcus.roomView = { init, update, setPhase, prefillCode };
})();

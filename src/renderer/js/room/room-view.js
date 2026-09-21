'use strict';

/**
 * The study room panel and the admission dialog.
 *
 * It draws the view snapshot main publishes and turns clicks into controller
 * calls. It never touches RTCPeerConnection and holds no room state of its own
 * beyond which step of a copy-paste handshake is on screen.
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

  function buildIdle() {
    ui.name = el('input', { type: 'text', id: 'room-name', maxlength: 40, placeholder: 'Your name', autocomplete: 'off' });
    ui.name.value = storedName();

    ui.idleError = el('p', { class: 'room-note', hidden: true });

    ui.createBtn = el('button', { class: 'btn primary', text: 'Create a room', onclick: onCreate });
    ui.joinBtn = el('button', { class: 'btn ghost', text: 'Join a room', onclick: onShowJoin });

    ui.inviteBox = codeBox({ readonly: true, placeholder: 'Your invite appears here' });
    ui.copyInvite = el('button', { class: 'btn primary', text: 'Copy Invite', onclick: onCopyInvite });
    ui.replyBox = codeBox({ placeholder: 'Paste the reply here' });
    ui.connectBtn = el('button', { class: 'btn ghost', text: 'Connect', onclick: onConnect });
    ui.joinNote = el('p', { class: 'room-note', hidden: true });

    ui.joinFlow = el('div', { class: 'room-flow', hidden: true }, [
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
      ui.joinNote,
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
        text: 'Study together over a direct peer-to-peer link. There is no server: you trade short codes by message to connect.',
      }),
      field('Your name', ui.name),
      el('div', { class: 'room-row' }, [ui.createBtn, ui.joinBtn]),
      ui.idleError,
      ui.joinFlow,
      el('details', { class: 'room-details' }, [
        el('summary', { text: 'Relay server (optional)' }),
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
    const result = await controller.create(name);
    say(ui.idleError, result.ok ? '' : result.error, 'error');
  }

  function onShowJoin() {
    if (!nameOrError()) return;
    say(ui.idleError, '');
    ui.joinFlow.hidden = false;
    ui.inviteBox.value = '';
    ui.replyBox.value = '';
    say(ui.joinNote, '');
  }

  async function onCopyInvite() {
    const name = nameOrError();
    if (!name) return;
    ui.copyInvite.disabled = true;
    say(ui.joinNote, 'Preparing your invite…', 'info');
    const result = await controller.makeInvite(name);
    ui.copyInvite.disabled = false;
    if (!result.ok) {
      say(ui.joinNote, result.error, 'error');
      return;
    }
    say(ui.joinNote, '');
    ui.inviteBox.value = result.invite;
    copyText(result.invite, ui.copyInvite, ui.inviteBox);
  }

  async function onConnect() {
    const text = ui.replyBox.value.trim();
    if (!text) {
      say(ui.joinNote, 'Paste the reply first.', 'error');
      return;
    }
    ui.connectBtn.disabled = true;
    const result = await controller.useReply(text);
    ui.connectBtn.disabled = false;
    say(ui.joinNote, result.ok ? 'Connecting…' : result.error, result.ok ? 'info' : 'error');
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
    ui.joiningNote = el('p', { class: 'room-lede', text: 'Connected. Waiting for the host to let you in…' });
    ui.joining = el('section', { class: 'room-section', hidden: true }, [
      el('h2', { class: 'section-title', text: 'Joining' }),
      ui.joiningNote,
      el('div', { class: 'room-row' }, [
        el('button', { class: 'btn ghost', text: 'Cancel', onclick: () => controller.leave() }),
      ]),
    ]);
  }

  // ------------------------------------------------------------ room screen

  function buildActive() {
    ui.mnemonic = el('div', { class: 'room-mnemonic' });
    ui.roomSub = el('div', { class: 'room-sub' });
    ui.members = el('ul', { class: 'room-members' });
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

    ui.active = el('section', { class: 'room-section', hidden: true }, [
      el('div', { class: 'room-head' }, [
        el('div', { class: 'micro', text: 'Room' }),
        ui.mnemonic,
        ui.roomSub,
      ]),
      ui.members,
      ui.waiting,
      el('details', { class: 'room-details' }, [
        el('summary', { text: 'Add someone' }),
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
        el('button', { class: 'btn ghost', text: 'Leave room', onclick: () => controller.leave() }),
      ]),
    ]);
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

  function renderMembers(view) {
    ui.members.replaceChildren(
      ...view.members.map((member) =>
        el('li', { class: 'room-member' + (member.connected ? '' : ' offline') }, [
          el('span', { class: 'member-dot', 'aria-hidden': 'true' }),
          el('span', { class: 'member-name', text: member.name }),
          member.isSelf ? el('span', { class: 'member-tag', text: 'You' }) : null,
          member.isHost ? el('span', { class: 'member-tag host', text: 'Host' }) : null,
          !member.connected && !member.isSelf ? el('span', { class: 'member-tag', text: 'Connecting' }) : null,
        ])
      )
    );
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
          ? 'Sent you a reply directly.'
          : `Introduced by ${entry.introducerName}.`,
      }),
      el('div', { class: 'micro', text: 'Their key fingerprint' }),
      el('div', { class: 'admit-fingerprint', text: entry.fingerprint }),
      el('p', {
        class: 'room-help',
        text: 'Ask them to read out their fingerprint. Only admit them if it matches exactly.',
      }),
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

    if (status === 'active') {
      ui.mnemonic.textContent = view.mnemonic;
      ui.roomSub.textContent =
        `${view.members.length} of ${view.maxPeers} · ${view.isHost ? 'You are the host' : 'You are a member'}`;
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

  Flowcus.roomView = { init, update };
})();

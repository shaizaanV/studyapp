'use strict';

const { ipcMain } = require('electron');

const P = require('../shared/room-protocol');

/** Public STUN only: it learns a peer's public address and carries no traffic. */
const STUN_URLS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
];

const MAX_TEXT = 40000;
const isText = (value, max = MAX_TEXT) => typeof value === 'string' && value.length > 0 && value.length <= max;
const cleanName = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, P.MAX_NAME_LENGTH);

/** Only a real TURN url may be stored; anything else is dropped rather than passed to WebRTC. */
function normalizeTurn(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const url = String(input.url || '').trim();
  if (!/^turns?:[^\s]{1,200}$/i.test(url)) return { url: '', username: '', credential: '' };
  return {
    url,
    username: String(input.username || '').slice(0, 200),
    credential: String(input.credential || '').slice(0, 500),
  };
}

/**
 * The main-process end of the room bridge. Every handler validates its own
 * arguments: the renderer is treated as an untrusted transport, so nothing it
 * sends is believed beyond what RoomService itself verifies.
 *
 * @param {object} deps
 * @param {import('./room-service').RoomService} deps.service
 * @param {import('./window-manager').WindowManager} deps.windows
 * @param {{read(): Buffer|null, write(b: Buffer): boolean}} deps.turnSecret
 * @param {() => boolean} deps.localIsIdle Rooms take over the timer, so a running personal session blocks them.
 */
function registerRoomIpc({ service, windows, turnSecret, localIsIdle }) {
  const loadTurn = () => {
    const stored = turnSecret.read();
    if (!stored) return normalizeTurn(null);
    try {
      return normalizeTurn(JSON.parse(stored.toString('utf8')));
    } catch {
      return normalizeTurn(null);
    }
  };

  const iceServers = () => {
    const turn = loadTurn();
    const servers = [{ urls: STUN_URLS }];
    if (turn.url) servers.push({ urls: turn.url, username: turn.username, credential: turn.credential });
    return servers;
  };

  const busy = { ok: false, error: 'Stop your current session before joining a room.' };

  service.on('send', (payload) => windows.send('flowcus:room-send', payload));
  service.on('close', (payload) => windows.send('flowcus:room-close', payload));
  service.on('relay-connect', (payload) => windows.send('flowcus:room-relay-connect', payload));
  service.on('relay-signal', (payload) => windows.send('flowcus:room-relay-signal', payload));
  service.on('state', (view) => windows.send('flowcus:room-state', view));

  ipcMain.handle('flowcus:room-get', () => ({ view: service.view(), iceServers: iceServers() }));

  ipcMain.handle('flowcus:room-create', (_event, name) => {
    if (service.status === 'active') return { ok: false, error: 'You are already in a room.' };
    if (!localIsIdle()) return busy;
    const clean = cleanName(name);
    if (!clean) return { ok: false, error: 'Enter a name first.' };
    return { ok: true, view: service.createRoom(clean) };
  });

  ipcMain.handle('flowcus:room-make-invite', (_event, args) => {
    if (!localIsIdle()) return busy;
    const name = cleanName(args && args.name);
    if (!name) return { ok: false, error: 'Enter a name first.' };
    if (!args || !isText(args.sdp)) return { ok: false, error: 'Could not build the invite.' };
    return service.makeInvite(name, args.sdp);
  });

  ipcMain.handle('flowcus:room-open-invite', (_event, text) =>
    isText(text) ? service.openInvite(text) : { ok: false, error: 'Paste an invite first.' }
  );
  ipcMain.handle('flowcus:room-make-reply', (_event, sdp) =>
    isText(sdp) ? service.makeReply(sdp) : { ok: false, error: 'Could not build the reply.' }
  );
  ipcMain.handle('flowcus:room-open-reply', (_event, text) =>
    isText(text) ? service.openReply(text) : { ok: false, error: 'Paste a reply first.' }
  );

  ipcMain.handle('flowcus:room-approve', (_event, key) => (isText(key, 256) ? service.approve(key) : { ok: false }));
  ipcMain.handle('flowcus:room-deny', (_event, key) => (isText(key, 256) ? service.deny(key) : { ok: false }));
  ipcMain.handle('flowcus:room-chat', (_event, text) => service.sendChat(text));
  ipcMain.handle('flowcus:room-leave', () => {
    service.leave();
    return { ok: true };
  });
  ipcMain.handle('flowcus:room-relay-out', (_event, args) => {
    const valid = args && isText(args.to, 256) && ['offer', 'answer'].includes(args.kind) && isText(args.sdp, 16384);
    return valid ? service.relayOut(args) : { ok: false };
  });

  ipcMain.handle('flowcus:room-turn-get', () => loadTurn());
  ipcMain.handle('flowcus:room-turn-set', (_event, raw) => {
    const turn = normalizeTurn(raw);
    turnSecret.write(Buffer.from(JSON.stringify(turn)));
    return { turn, iceServers: iceServers() };
  });

  ipcMain.on('flowcus:room-channel-open', (_event, args) => {
    if (!args || !isText(args.channelId, 64) || !['admit', 'joiner', 'relay'].includes(args.mode) || !isText(args.peerKey, 256)) return;
    service.channelOpen(args);
  });
  ipcMain.on('flowcus:room-channel-closed', (_event, channelId) => {
    if (isText(channelId, 64)) service.channelClosed(channelId);
  });
  ipcMain.on('flowcus:room-data', (_event, args) => {
    if (args && isText(args.channelId, 64) && typeof args.data === 'string') service.handleData(args.channelId, args.data);
  });
}

module.exports = { registerRoomIpc, normalizeTurn, STUN_URLS };

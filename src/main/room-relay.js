'use strict';

const { EventEmitter } = require('node:events');

const HANDSHAKE_MS = 8000;
const ANSWER_MS = 25000;
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 15000;

/** What the person sees for each relay error code. */
function describeError(error) {
  const wait = error.retryAfterS ? ` Try again in ${Math.max(1, Math.ceil(error.retryAfterS / 60))} min.` : '';
  switch (error.code) {
    case 'invalid': return "That code isn't valid. Check it and try again.";
    case 'rate_limited': return `Too many attempts.${wait}`;
    case 'banned': return 'You are banned from this room.';
    case 'full': return 'That room is full.';
    case 'closed': return 'That room has closed.';
    case 'unsupported': return 'Your version of Flowcus is not supported. Please relaunch to update.';
    case 'busy': return 'Nobody in the room could take your request. Try again in a moment.';
    case 'disabled': return 'Joining by code is switched off right now. Use Advanced to join with an invite.';
    case 'timeout': return 'That took too long. Try again.';
    case 'unreachable': return 'Could not reach the Flowcus relay. Use Advanced to join with an invite.';
    default: return 'Something went wrong with the relay. Try again.';
  }
}

/**
 * A promise-and-queue wrapper around a WebSocket-like object (the global
 * WebSocket in Electron's main process, or a fake in tests). During the
 * handshake the caller awaits `next()`; afterwards `listen()` switches to push.
 */
class Conn {
  constructor(ws) {
    this.ws = ws;
    this.queue = [];
    this.waiter = null;
    this.handler = null;
    this.closed = false;
    this.onclose = null;
    this.keepalive = null;
    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      if (this.handler) this.handler(msg);
      else if (this.waiter) this.waiter.resolve(msg);
      else this.queue.push(msg);
    });
    const closed = () => {
      if (this.closed) return;
      this.closed = true;
      clearInterval(this.keepalive);
      if (this.waiter) this.waiter.resolve(null);
      if (this.onclose) this.onclose();
    };
    ws.addEventListener('close', closed);
    ws.addEventListener('error', closed);
  }

  send(obj) {
    if (!this.closed) this.ws.send(JSON.stringify(obj));
  }

  /** A bare 'ping' text frame every 30 s keeps idle connections alive; the relay answers it without waking. */
  startKeepalive() {
    this.keepalive = setInterval(() => {
      try { this.ws.send('ping'); } catch { /* socket already gone */ }
    }, 30000);
    if (this.keepalive.unref) this.keepalive.unref();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.keepalive);
    try { this.ws.close(); } catch { /* already closed */ }
  }

  /** Next message, or null on close/timeout. */
  next(timeoutMs) {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiter = null; resolve(null); }, timeoutMs);
      this.waiter = { resolve: (m) => { clearTimeout(timer); this.waiter = null; resolve(m); } };
    });
  }

  listen(handler) {
    this.handler = handler;
    while (this.queue.length > 0) handler(this.queue.shift());
  }
}

/**
 * The main-process client for the signaling relay. The renderer never touches
 * the network (its CSP forbids it); it only ever sees the signed blobs this
 * module hands over IPC.
 *
 * Events: 'offer' {joinId, invite}, 'code' {code}, 'closed' {reason}, 'link' 'up'|'down'.
 */
class RelayClient extends EventEmitter {
  constructor({ url, appVersion, protocol, auth, WebSocketImpl, fetchImpl, setTimer }) {
    super();
    this.url = url;
    this.appVersion = appVersion;
    this.protocol = protocol;
    this.auth = auth;
    this.WS = WebSocketImpl || globalThis.WebSocket;
    this.fetch = fetchImpl || globalThis.fetch;
    this.setTimer = setTimer || ((ms, fn) => setTimeout(fn, ms));
    this.member = null;
    this.roomId = null;
    this.code = null;
    this.wanted = false;
    this.backoff = BACKOFF_START_MS;
    this.reconnectTimer = null;
    this.infoCache = null;
    this.memberTries = 0;
  }

  /** False when no relay URL is built in: joining is Advanced-only. */
  get configured() {
    return Boolean(this.url);
  }

  get client() {
    return { app: this.appVersion, proto: this.protocol };
  }

  httpUrl(path) {
    return `${this.url.replace(/^ws/, 'http')}${path}`;
  }

  open(query) {
    return new Promise((resolve) => {
      let ws;
      try {
        ws = new this.WS(`${this.url}/v1/ws?${query}`);
      } catch {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } resolve(null); }, HANDSHAKE_MS);
      const conn = new Conn(ws);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(conn); });
      ws.addEventListener('error', () => { clearTimeout(timer); resolve(null); });
    });
  }

  /** Relay policy, cached for five minutes. Null when unreachable. */
  async info() {
    const now = Date.now();
    if (this.infoCache && now - this.infoCache.at < 5 * 60000) return this.infoCache.value;
    try {
      const response = await this.fetch(this.httpUrl('/v1/info'));
      const value = await response.json();
      this.infoCache = { at: now, value };
      return value;
    } catch {
      return null;
    }
  }

  async authenticate(conn, roomId) {
    const challenge = await conn.next(HANDSHAKE_MS);
    if (!challenge || challenge.t !== 'challenge') return challenge || { t: 'err', code: 'unreachable' };
    conn.send({ t: 'auth', proof: this.auth.signObject({ aud: 'flowcus-relay', roomId, nonce: challenge.nonce, pubKey: this.auth.publicKey }) });
    return null;
  }

  /** Host: register a freshly created room and get its code. */
  async createRoom(rosterRaw) {
    const roster = JSON.parse(rosterRaw);
    const conn = await this.open(`intent=create&room=${encodeURIComponent(roster.body.roomId)}`);
    if (!conn) return { ok: false, error: describeError({ code: 'unreachable' }) };
    conn.send({ t: 'create', client: this.client, frame: rosterRaw });
    const failed = await this.authenticate(conn, roster.body.roomId);
    if (failed) { conn.close(); return { ok: false, error: describeError(failed) }; }
    const created = await conn.next(HANDSHAKE_MS);
    if (!created || created.t !== 'created') {
      conn.close();
      return { ok: false, error: describeError(created || { code: 'unreachable' }) };
    }
    this.code = created.code;
    this.adoptMember(conn, roster.body.roomId);
    return { ok: true, code: created.code };
  }

  /** Joiner: validate a code with the relay. On success returns a session for the offer/answer exchange. */
  async joinWithCode(code) {
    const conn = await this.open(`intent=join&code=${encodeURIComponent(code)}`);
    if (!conn) return { ok: false, error: describeError({ code: 'unreachable' }) };
    conn.send({ t: 'hello', role: 'joiner', client: this.client });
    const reply = await conn.next(HANDSHAKE_MS);
    if (!reply || reply.t !== 'ok') {
      conn.close();
      return { ok: false, error: describeError(reply || { code: 'unreachable' }), code: reply && reply.code };
    }
    return { ok: true, admission: reply.admission, session: new JoinSession(conn) };
  }

  /** Member: (re)attach to a room's relay presence, and keep doing so until `leave()`. */
  async memberConnect(roomId) {
    this.roomId = roomId;
    this.wanted = true;
    this.memberTries = 0;
    return this.connectMember();
  }

  async connectMember() {
    if (!this.wanted || this.member) return false;
    const conn = await this.open(`intent=member&room=${encodeURIComponent(this.roomId)}`);
    if (!conn) { this.scheduleReconnect(); return false; }
    conn.send({ t: 'hello', role: 'member', client: this.client, pubKey: this.auth.publicKey });
    const failed = await this.authenticate(conn, this.roomId);
    const ready = failed ? failed : await conn.next(HANDSHAKE_MS);
    if (!ready || ready.t !== 'ready') {
      conn.close();
      // Right after admission the relay may not have the roster that lists us yet, so 'invalid' is retried a few times.
      const early = ready && ready.t === 'err' && ready.code === 'invalid' && (this.memberTries += 1) <= 6;
      if (!early && ready && ready.t === 'err' && ['closed', 'invalid', 'banned', 'unsupported'].includes(ready.code)) {
        this.wanted = false; // the room is gone or we are not in it: retrying would not help
        this.emit('closed', { reason: ready.code });
      } else {
        this.scheduleReconnect();
      }
      return false;
    }
    this.adoptMember(conn, this.roomId);
    if (typeof ready.code === 'string') {
      this.code = ready.code;
      this.emit('code', { code: ready.code });
    }
    return true;
  }

  adoptMember(conn, roomId) {
    this.roomId = roomId;
    this.wanted = true;
    this.member = conn;
    this.backoff = BACKOFF_START_MS;
    conn.listen((msg) => this.onMemberMessage(msg));
    conn.startKeepalive();
    conn.onclose = () => {
      if (this.member !== conn) return;
      this.member = null;
      this.emit('link', 'down');
      this.scheduleReconnect();
    };
    this.emit('link', 'up');
  }

  onMemberMessage(msg) {
    if (msg.t === 'offer' && typeof msg.joinId === 'string' && typeof msg.invite === 'string') {
      this.emit('offer', { joinId: msg.joinId, invite: msg.invite });
    } else if (msg.t === 'code' && typeof msg.code === 'string') {
      this.code = msg.code;
      this.emit('code', { code: msg.code });
    } else if (msg.t === 'closed') {
      this.wanted = false;
      this.emit('closed', { reason: msg.reason });
    }
  }

  scheduleReconnect() {
    if (!this.wanted || this.reconnectTimer) return;
    const wait = this.backoff;
    this.backoff = Math.min(BACKOFF_MAX_MS, this.backoff * 2);
    this.reconnectTimer = this.setTimer(wait, () => {
      this.reconnectTimer = null;
      this.connectMember();
    });
  }

  answer(joinId, reply) { if (this.member) this.member.send({ t: 'answer', joinId, reply }); }
  decline(joinId, reason) { if (this.member) this.member.send({ t: 'decline', joinId, reason }); }
  syncRoster(frame) { if (this.member) this.member.send({ t: 'roster', frame }); }
  rotate() { if (this.member) this.member.send({ t: 'rotate' }); }
  end() { if (this.member) this.member.send({ t: 'end' }); }

  /** Drops relay presence (leaving or ending a room). */
  leave() {
    this.wanted = false;
    this.roomId = null;
    this.code = null;
    const member = this.member;
    this.member = null;
    if (member) member.close();
  }
}

/** One joiner's side of the offer/answer exchange. */
class JoinSession {
  constructor(conn) {
    this.conn = conn;
  }

  /** Sends the signed invite and waits for a member's reply blob. */
  async offer(invite) {
    this.conn.send({ t: 'offer', invite });
    const deadline = Date.now() + ANSWER_MS;
    for (;;) {
      const msg = await this.conn.next(Math.max(1, deadline - Date.now()));
      if (!msg) return { ok: false, error: describeError({ code: Date.now() >= deadline ? 'timeout' : 'unreachable' }) };
      if (msg.t === 'queued') continue;
      if (msg.t === 'answer') return { ok: true, reply: msg.reply };
      if (msg.t === 'declined') {
        const code = { banned: 'banned', full: 'full', rotated: 'closed' }[msg.reason] || 'busy';
        return { ok: false, error: describeError({ code }) };
      }
      if (msg.t === 'err') return { ok: false, error: describeError(msg) };
    }
  }

  done() { this.conn.send({ t: 'done' }); this.conn.close(); }
  close() { this.conn.close(); }
}

module.exports = { RelayClient, describeError };

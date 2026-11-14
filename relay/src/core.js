'use strict';

/**
 * The relay's logic with no Cloudflare APIs: a Directory (code -> room, and
 * every rate limit) and one RoomCore per room. The Durable Object classes in
 * directory.js / room.js are thin adapters over these.
 *
 * The relay only carries the signed handshake blobs between a joiner and a
 * room member. It never sees timer or chat traffic, and it cannot alter a blob
 * without breaking its signature.
 */
const P = require('../../src/shared/room-protocol');
const Code = require('../../src/shared/room-code');
const V = require('./verify');

const LIMITS = {
  failWindowMs: 10 * 60000,
  failMax: 8,
  blockBaseMs: 10 * 60000,
  blockMaxMs: 60 * 60000,
  createPerHour: 10,
  liveRoomsPerIp: 3,
  offersPerIpWindowMs: 10 * 60000,
  offersPerIpMax: 10,
  offersPerRoomPerMin: 6,
  offerDeadlineMs: 8000,
  maxCandidates: 3,
  joinerLifetimeMs: 60000,
  recentJoinMs: 60 * 60000,
  emptyGraceMs: 120000,
  maxOfferChars: 24 * 1024,
};

const pruneOld = (list, cutoff) => list.filter((t) => t > cutoff);

/** Code allocation and every per-IP limit. State is plain data so it can be snapshotted. */
class DirectoryCore {
  constructor({ now = Date.now, randomBytes, snapshot } = {}) {
    this.now = now;
    this.randomBytes = randomBytes || ((n) => crypto.getRandomValues(new Uint8Array(n)));
    this.codes = new Map(); // code -> roomId
    this.rooms = new Map(); // roomId -> {code, ipHash}
    this.fails = new Map(); // ipHash -> {times: number[], blockedUntil, level}
    this.creates = new Map(); // ipHash -> number[]
    if (snapshot) this.restore(snapshot);
  }

  snapshot() {
    return {
      rooms: [...this.rooms].map(([roomId, r]) => ({ roomId, ...r })),
      fails: [...this.fails],
      creates: [...this.creates],
    };
  }

  restore(snap) {
    for (const r of snap.rooms || []) {
      this.codes.set(r.code, r.roomId);
      this.rooms.set(r.roomId, { code: r.code, ipHash: r.ipHash });
    }
    this.fails = new Map(snap.fails || []);
    this.creates = new Map(snap.creates || []);
  }

  /**
   * Registers a room under the id its creator chose (the room's signed roster
   * already carries it) and allocates its code. Returns {roomId, code} or
   * {error, retryAfterS?}.
   */
  create(ipHash, roomId) {
    if (typeof roomId !== 'string' || !/^[0-9a-f]{24}$/.test(roomId) || this.rooms.has(roomId)) return { error: 'invalid' };
    const now = this.now();
    const recent = pruneOld(this.creates.get(ipHash) || [], now - 3600000);
    if (recent.length >= LIMITS.createPerHour) return { error: 'rate_limited', retryAfterS: 600 };
    const live = [...this.rooms.values()].filter((r) => r.ipHash === ipHash).length;
    if (live >= LIMITS.liveRoomsPerIp) return { error: 'rate_limited', retryAfterS: 600 };
    recent.push(now);
    this.creates.set(ipHash, recent);

    const code = this.freshCode();
    this.codes.set(code, roomId);
    this.rooms.set(roomId, { code, ipHash });
    return { roomId, code };
  }

  freshCode() {
    for (let i = 0; i < 20; i += 1) {
      const code = Code.generate(this.randomBytes);
      if (!this.codes.has(code)) return code;
    }
    throw new Error('code space exhausted');
  }

  /** A joiner's guess. Wrong guesses count against the IP; a right one does not. */
  lookup(rawCode, ipHash) {
    const now = this.now();
    const record = this.fails.get(ipHash) || { times: [], blockedUntil: 0, level: 0 };
    if (record.blockedUntil > now) return { error: 'rate_limited', retryAfterS: Math.ceil((record.blockedUntil - now) / 1000) };

    const code = Code.normalize(rawCode);
    const roomId = code ? this.codes.get(code) : undefined;
    if (roomId) return { roomId };

    record.times = pruneOld(record.times, now - LIMITS.failWindowMs);
    record.times.push(now);
    if (record.times.length >= LIMITS.failMax) {
      record.level += 1;
      record.blockedUntil = now + Math.min(LIMITS.blockMaxMs, LIMITS.blockBaseMs * 2 ** (record.level - 1));
      record.times = [];
    }
    this.fails.set(ipHash, record);
    return { error: 'invalid' };
  }

  /** Replaces a room's code. The old one stops working at once. */
  rotate(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return { error: 'closed' };
    this.codes.delete(room.code);
    room.code = this.freshCode();
    this.codes.set(room.code, roomId);
    return { code: room.code };
  }

  release(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    this.codes.delete(room.code);
    this.rooms.delete(roomId);
  }

  codeOf(roomId) {
    const room = this.rooms.get(roomId);
    return room ? room.code : null;
  }
}

/**
 * One room's signaling state. Connections are abstract: {id, send(obj),
 * close(), ipHash, state: {}}; the adapter owns the sockets.
 */
class RoomCore {
  /**
   * @param {object} deps
   * @param {string} deps.roomId
   * @param {{minApp: string, proto: number}} deps.policy
   * @param {() => number} deps.now
   * @param {(roomId: string) => Promise<{code?: string, error?: string}>} deps.rotateCode
   * @param {(roomId: string) => Promise<void>} deps.releaseRoom
   * @param {(ms: number, fn: () => void, opts?: {durable?: boolean}) => () => void} deps.schedule returns a cancel function
   * @param {() => Uint8Array} deps.nonce
   */
  constructor({ roomId, code, policy, now = Date.now, rotateCode, releaseRoom, schedule, nonce, snapshot }) {
    this.roomId = roomId;
    this.code = code;
    this.policy = policy;
    this.now = now;
    this.rotateCode = rotateCode;
    this.releaseRoom = releaseRoom;
    this.schedule = schedule || ((ms, fn) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
    this.nonce = nonce || (() => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join(''));
    this.conns = new Map();
    this.offers = new Map(); // joinId -> {joiner, invite, targets, index, cancel}
    this.hostKey = null;
    this.hostSeq = 0;
    this.rosterSeq = 0;
    this.roster = null;
    this.bannedIps = new Set();
    this.recentJoins = new Map(); // pubKey -> {ipHash, at}
    this.offerTimes = [];
    this.perIp = new Map(); // ipHash -> number[] of offer times
    this.closed = false;
    this.cancelEmpty = null;
    if (snapshot) this.restore(snapshot);
  }

  snapshot() {
    return {
      hostKey: this.hostKey, hostSeq: this.hostSeq, rosterSeq: this.rosterSeq, roster: this.roster,
      bannedIps: [...this.bannedIps], recentJoins: [...this.recentJoins], code: this.code,
    };
  }

  restore(s) {
    Object.assign(this, { hostKey: s.hostKey, hostSeq: s.hostSeq, rosterSeq: s.rosterSeq, roster: s.roster, code: s.code });
    this.bannedIps = new Set(s.bannedIps || []);
    this.recentJoins = new Map(s.recentJoins || []);
  }

  // ----------------------------------------------------------- connections

  addConn(conn) {
    conn.state = conn.state || { role: 'new', pubKey: null, authed: false };
    this.conns.set(conn.id, conn);
    if (this.cancelEmpty) {
      this.cancelEmpty();
      this.cancelEmpty = null;
    }
  }

  removeConn(conn) {
    this.conns.delete(conn.id);
    for (const [joinId, offer] of [...this.offers]) {
      if (offer.joiner === conn) this.dropOffer(joinId);
    }
    if (this.membersOnline().length === 0 && this.hostKey) this.armEmptyTimer();
  }

  membersOnline() {
    return [...this.conns.values()].filter((c) => c.state.authed && (c.state.role === 'host' || c.state.role === 'member'));
  }

  armEmptyTimer() {
    if (this.cancelEmpty) return;
    this.cancelEmpty = this.schedule(LIMITS.emptyGraceMs, () => this.emptyCheck(), { durable: true });
  }

  /** Called when the empty-room grace period ends. */
  emptyCheck() {
    this.cancelEmpty = null;
    if (this.membersOnline().length === 0) this.close('closed');
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    for (const conn of [...this.conns.values()]) {
      conn.send({ t: 'closed', reason });
      conn.close();
    }
    this.conns.clear();
    for (const joinId of [...this.offers.keys()]) this.dropOffer(joinId);
    this.releaseRoom(this.roomId);
  }

  // ---------------------------------------------------------------- inbound

  async onMessage(conn, msg) {
    if (this.closed || !msg || typeof msg !== 'object') return;
    try {
      switch (msg.t) {
        case 'create': return await this.onCreate(conn, msg);
        case 'hello': return await this.onHello(conn, msg);
        case 'auth': return await this.onAuth(conn, msg);
        case 'offer': return await this.onOffer(conn, msg);
        case 'answer': return this.onAnswer(conn, msg);
        case 'decline': return this.onDecline(conn, msg);
        case 'done': return this.onDone(conn);
        case 'roster': return await this.onRoster(conn, msg);
        case 'rotate': return await this.onRotate(conn);
        case 'end': return this.onEnd(conn);
        default: return undefined;
      }
    } catch {
      conn.send({ t: 'err', code: 'internal' });
    }
  }

  clientError(client) {
    if (!client || typeof client !== 'object') return { code: 'unsupported', minApp: this.policy.minApp };
    if (client.proto !== this.policy.proto || V.compareVersions(String(client.app || '0'), this.policy.minApp) < 0) {
      return { code: 'unsupported', minApp: this.policy.minApp };
    }
    return null;
  }

  async onCreate(conn, msg) {
    if (this.hostKey || conn.state.role !== 'new') return conn.send({ t: 'err', code: 'invalid' });
    const unsupported = this.clientError(msg.client);
    if (unsupported) return this.fail(conn, unsupported);
    const frame = await V.verifyFrame(msg.frame);
    if (!frame || frame.type !== 'roster' || frame.body.roomId !== this.roomId || frame.body.hostKey !== frame.from) {
      return this.fail(conn, { code: 'invalid' });
    }
    conn.state = { role: 'host', pubKey: frame.from, authed: false, nonce: this.nonce(), pendingRoster: frame };
    conn.send({ t: 'challenge', nonce: conn.state.nonce });
  }

  async onHello(conn, msg) {
    if (conn.state.role !== 'new') return undefined;
    const unsupported = this.clientError(msg.client);
    if (unsupported) return this.fail(conn, unsupported);
    if (!this.hostKey) return this.fail(conn, { code: 'closed' });

    if (msg.role === 'joiner') {
      if (this.roster && this.roster.members.length >= P.MAX_PEERS) return this.fail(conn, { code: 'full' });
      conn.state = { role: 'joiner', pubKey: null, authed: true, joinedAt: this.now() };
      conn.send({ t: 'ok', admission: (this.roster && this.roster.admission) || 'open' });
      conn.cancelLifetime = this.schedule(LIMITS.joinerLifetimeMs, () => {
        conn.send({ t: 'err', code: 'timeout' });
        conn.close();
      });
      return undefined;
    }
    if (msg.role === 'member' && typeof msg.pubKey === 'string' && this.roster && this.roster.members.includes(msg.pubKey)) {
      conn.state = { role: 'member', pubKey: msg.pubKey, authed: false, nonce: this.nonce() };
      conn.send({ t: 'challenge', nonce: conn.state.nonce });
      return undefined;
    }
    return this.fail(conn, { code: 'invalid' });
  }

  async onAuth(conn, msg) {
    const st = conn.state;
    if (st.authed || !st.nonce || !st.pubKey) return;
    const proof = msg.proof;
    const good = proof && proof.aud === 'flowcus-relay' && proof.roomId === this.roomId && proof.nonce === st.nonce &&
      (await V.verifyObject(proof, st.pubKey));
    if (!good) return this.fail(conn, { code: 'invalid' });
    st.authed = true;
    st.nonce = null;
    if (st.role === 'host') {
      const frame = st.pendingRoster;
      st.pendingRoster = null;
      this.hostKey = frame.from;
      this.hostSeq = frame.body.hostSeq;
      this.rosterSeq = frame.body.rosterSeq;
      this.roster = frame.body;
      conn.send({ t: 'created', code: this.code });
    } else {
      conn.send({ t: 'ready', code: this.code });
    }
    if (this.cancelEmpty) {
      this.cancelEmpty();
      this.cancelEmpty = null;
    }
  }

  fail(conn, error) {
    conn.send({ t: 'err', ...error });
    conn.close();
  }

  // ------------------------------------------------------------ join routing

  candidates() {
    const online = this.membersOnline();
    const byKey = new Map(online.map((c) => [c.state.pubKey, c]));
    const order = [this.hostKey, ...((this.roster && this.roster.mods) || []), ...((this.roster && this.roster.members) || [])];
    const seen = new Set();
    const out = [];
    for (const key of order) {
      if (seen.has(key) || !byKey.has(key)) continue;
      seen.add(key);
      out.push(byKey.get(key));
    }
    return out;
  }

  async onOffer(conn, msg) {
    const st = conn.state;
    if (st.role !== 'joiner' || st.offered) return;
    if (typeof msg.invite !== 'string' || msg.invite.length > LIMITS.maxOfferChars) return this.fail(conn, { code: 'invalid' });

    const now = this.now();
    this.offerTimes = pruneOld(this.offerTimes, now - 60000);
    const mine = pruneOld(this.perIp.get(conn.ipHash) || [], now - LIMITS.offersPerIpWindowMs);
    if (this.offerTimes.length >= LIMITS.offersPerRoomPerMin || mine.length >= LIMITS.offersPerIpMax) {
      return this.fail(conn, { code: 'rate_limited', retryAfterS: 60 });
    }
    this.offerTimes.push(now);
    mine.push(now);
    this.perIp.set(conn.ipHash, mine);

    const opened = await V.openInvite(msg.invite, now);
    if (opened.error) return this.fail(conn, { code: opened.error === 'unsupported' ? 'unsupported' : 'invalid', minApp: this.policy.minApp });
    const { invite } = opened;
    if ((this.roster.banned || []).includes(invite.pubKey) || this.bannedIps.has(conn.ipHash)) return this.fail(conn, { code: 'banned' });
    if (this.roster.members.includes(invite.pubKey)) return this.fail(conn, { code: 'invalid' });
    if (this.roster.members.length >= P.MAX_PEERS) return this.fail(conn, { code: 'full' });

    st.offered = true;
    st.pubKey = invite.pubKey;
    this.recentJoins.set(invite.pubKey, { ipHash: conn.ipHash, at: now });
    const targets = this.candidates();
    if (targets.length === 0) return this.fail(conn, { code: 'busy' });

    const joinId = this.nonce();
    this.offers.set(joinId, { joiner: conn, invite: msg.invite, targets, index: -1, cancel: null });
    conn.send({ t: 'queued' });
    this.tryNextTarget(joinId);
  }

  tryNextTarget(joinId) {
    const offer = this.offers.get(joinId);
    if (!offer) return;
    if (offer.cancel) offer.cancel();
    offer.index += 1;
    if (offer.index >= Math.min(offer.targets.length, LIMITS.maxCandidates)) {
      this.dropOffer(joinId);
      offer.joiner.send({ t: 'declined', reason: 'busy' });
      return;
    }
    offer.targets[offer.index].send({ t: 'offer', joinId, invite: offer.invite });
    offer.cancel = this.schedule(LIMITS.offerDeadlineMs, () => this.tryNextTarget(joinId));
  }

  dropOffer(joinId) {
    const offer = this.offers.get(joinId);
    if (!offer) return;
    if (offer.cancel) offer.cancel();
    this.offers.delete(joinId);
  }

  currentTarget(joinId) {
    const offer = this.offers.get(joinId);
    return offer ? offer.targets[offer.index] : null;
  }

  onAnswer(conn, msg) {
    const offer = this.offers.get(msg.joinId);
    if (!offer || this.currentTarget(msg.joinId) !== conn || !conn.state.authed) return;
    if (typeof msg.reply !== 'string' || msg.reply.length > LIMITS.maxOfferChars) return;
    this.dropOffer(msg.joinId);
    offer.joiner.send({ t: 'answer', reply: msg.reply });
  }

  onDecline(conn, msg) {
    const offer = this.offers.get(msg.joinId);
    if (!offer || this.currentTarget(msg.joinId) !== conn) return;
    if (msg.reason === 'banned' || msg.reason === 'full') {
      this.dropOffer(msg.joinId);
      offer.joiner.send({ t: 'declined', reason: msg.reason });
      return;
    }
    this.tryNextTarget(msg.joinId);
  }

  onDone(conn) {
    if (conn.state.role !== 'joiner') return;
    if (conn.cancelLifetime) conn.cancelLifetime();
    conn.close();
  }

  // ---------------------------------------------------------- roster + admin

  isController(conn) {
    if (!conn.state.authed || !this.roster) return false;
    return conn.state.pubKey === this.hostKey || (this.roster.mods || []).includes(conn.state.pubKey);
  }

  async onRoster(conn, msg) {
    if (!conn.state.authed || !['host', 'member'].includes(conn.state.role)) return;
    const frame = await V.verifyFrame(msg.frame);
    if (!frame || !['roster', 'host-claim'].includes(frame.type)) return;
    const roster = frame.type === 'roster' ? frame.body : frame.body.roster;
    if (!P.validateRoster(roster).ok || roster.roomId !== this.roomId || roster.hostKey !== frame.from) return;

    const sameHost = frame.from === this.hostKey && roster.hostSeq === this.hostSeq && roster.rosterSeq > this.rosterSeq;
    const succession = roster.hostSeq > this.hostSeq && this.roster.members.includes(frame.from) &&
      frame.type === 'host-claim' && roster.rosterSeq > this.rosterSeq;
    if (!sameHost && !succession) return;

    for (const key of roster.banned || []) {
      const seen = this.recentJoins.get(key);
      if (seen) this.bannedIps.add(seen.ipHash);
    }
    const cutoff = this.now() - LIMITS.recentJoinMs;
    for (const [key, v] of [...this.recentJoins]) if (v.at < cutoff) this.recentJoins.delete(key);

    this.hostKey = roster.hostKey;
    this.hostSeq = roster.hostSeq;
    this.rosterSeq = roster.rosterSeq;
    this.roster = roster;

    // A removed member loses their relay presence too.
    for (const c of [...this.conns.values()]) {
      if (c.state.authed && c.state.role !== 'joiner' && !roster.members.includes(c.state.pubKey)) {
        c.send({ t: 'closed', reason: 'removed' });
        c.close();
        this.conns.delete(c.id);
      } else if (c.state.authed && c.state.role === 'member' && c.state.pubKey === roster.hostKey) {
        c.state.role = 'host';
      }
    }
  }

  async onRotate(conn) {
    if (!this.isController(conn)) return;
    const result = await this.rotateCode(this.roomId);
    if (!result.code) return conn.send({ t: 'err', code: 'closed' });
    this.code = result.code;
    for (const c of this.membersOnline()) c.send({ t: 'code', code: result.code });
    // A rotation also drops joins that were in flight under the old code.
    for (const [joinId, offer] of [...this.offers]) {
      this.dropOffer(joinId);
      offer.joiner.send({ t: 'declined', reason: 'rotated' });
    }
  }

  onEnd(conn) {
    if (!conn.state.authed || conn.state.pubKey !== this.hostKey) return;
    this.close('ended');
  }
}

module.exports = { DirectoryCore, RoomCore, LIMITS };

'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const P = require('../shared/room-protocol');

const MAX_FRAME_CHARS = 64 * 1024;
const MAX_CHAT_LOG = 200;
const MAX_PENDING = 4;
const PING_MS = 10000;
const CLOCK_SAMPLES = 8;
/** A member the host has never heard from is given this long to finish connecting. */
const NEVER_SEEN_GRACE_MS = 30000;
/** A denied joiner's channel is closed shortly after, once the verdict has flushed. */
const DENY_FLUSH_MS = 1500;

/** Frames that must arrive on the channel of the peer who sent them. */
const DIRECT_ONLY = new Set(['heartbeat', 'ping', 'pong', 'chat', 'join-request', 'join-deny', 'leave']);

/**
 * Everything about a study room that is not the WebRTC plumbing or the UI:
 * identity, admission, roster and host handover, heartbeats, clock sync, chat,
 * and the shared timer feed.
 *
 * This is the trusted side of the seam. The renderer moves opaque strings
 * between data channels and this module; it never decides who is allowed in or
 * what the timer says. Every inbound string is parsed, shape-checked and
 * signature-verified here before any rule looks at it.
 *
 * Channels are identified by opaque ids chosen by the renderer. A channel is
 * `quarantined` (opened by pasting a stranger's invite: only a join-request
 * may cross it), `joining` (we opened it to the member who admitted us),
 * `active` (bound to a roster member), or `denied` (waiting to be closed).
 *
 * Outputs are events: 'send' {channelIds, data}, 'close' {channelId},
 * 'relay-connect' {peerKey}, 'relay-signal' {origin, kind, sdp}, 'state' (a
 * view snapshot), 'joined' and 'left' (the app should switch timers).
 */
class RoomService extends EventEmitter {
  /**
   * @param {object} deps
   * @param {ReturnType<import('./room-auth').createRoomAuth>} deps.auth
   * @param {ReturnType<import('./room-invite').createInviteCodec>} deps.invites
   * @param {import('./room-timer').RoomTimer} deps.timer
   * @param {() => number} [deps.now]
   */
  constructor({ auth, invites, timer, now = Date.now }) {
    super();
    this.auth = auth;
    this.invites = invites;
    this.timer = timer;
    this.now = now;
    this.interval = null;
    this.chatLimiter = P.createRateLimiter();
    this.pingLimiter = P.createRateLimiter({ perSecond: 2 });
    timer.on('broadcast', (state) => this.onTimerBroadcast(state));
    this.reset();
  }

  get selfKey() {
    return this.auth.publicKey;
  }

  get isHost() {
    return this.status === 'active' && this.roster.hostKey === this.selfKey;
  }

  reset() {
    this.status = 'idle'; // idle | joining | active
    this.selfName = '';
    this.roster = null;
    this.authorityRaw = null;
    this.timerRaw = null;
    this.lastTimerBody = null;
    this.channels = new Map(); // channelId -> {id, key, state, closeAt}
    this.byKey = new Map(); // peer key -> channelId, active channels only
    this.lastSeen = new Map();
    this.admittedAt = new Map();
    this.pending = new Map(); // joiner key -> {key, name, introducer, channelId, at}
    this.routes = new Map(); // origin key -> channelId a relayed frame arrived on
    this.relaySeq = new Map();
    this.hostLinked = false; // we have heard the host on a direct channel
    this.samples = [];
    this.chat = [];
    this.joining = null; // {introducerKey, roomId, since}
    this.error = null;
    this.hostHeardAt = 0;
    this.lastBeatAt = 0;
    this.lastPingAt = 0;
    this.createdAt = this.now();
  }

  // ---------------------------------------------------------------- lifecycle

  startTicking() {
    if (this.interval) return;
    this.interval = setInterval(() => this.tick(), 500);
  }

  stopTicking() {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }

  // ----------------------------------------------------------------- outputs

  sign(type, body) {
    return this.auth.signFrame(type, body);
  }

  sendTo(channelId, data) {
    if (this.channels.has(channelId)) this.emit('send', { channelIds: [channelId], data });
  }

  /** Sends to every active channel except `exceptId`. */
  broadcastRaw(data, exceptId) {
    const ids = [...this.byKey.values()].filter((id) => id !== exceptId);
    if (ids.length > 0) this.emit('send', { channelIds: ids, data });
  }

  closeChannel(channelId) {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    this.channels.delete(channelId);
    if (channel.key && this.byKey.get(channel.key) === channelId) this.byKey.delete(channel.key);
    for (const [key, entry] of this.pending) {
      if (entry.channelId === channelId) this.pending.delete(key);
    }
    this.emit('close', { channelId });
  }

  // ------------------------------------------------------------ room creation

  createRoom(name) {
    this.reset();
    this.selfName = name;
    this.status = 'active';
    const roomId = crypto.randomBytes(12).toString('hex');
    this.roster = {
      roomId,
      rosterSeq: 1,
      hostSeq: 0,
      hostKey: this.selfKey,
      members: [this.selfKey],
      names: { [this.selfKey]: name },
    };
    this.authorityRaw = this.sign('roster', this.roster);
    this.hostHeardAt = this.now();
    this.timer.becomeHost({ hostSeq: 0, inherit: false });
    this.emit('joined');
    this.emitState();
    return this.view();
  }

  // ------------------------------------------------------ manual handshake

  /** Joiner, step 1: wrap the renderer's offer SDP as a signed invite blob. */
  makeInvite(name, sdp) {
    if (this.status === 'active') return { ok: false, error: 'You are already in a room.' };
    this.reset();
    this.selfName = name;
    this.status = 'joining';
    return { ok: true, invite: this.invites.encode({ kind: 'invite', roomId: '', name, sdp }) };
  }

  /** Member, step 2: check a pasted invite and hand back what the renderer needs. */
  openInvite(text) {
    if (this.status !== 'active') return { ok: false, error: 'Create or join a room first.' };
    if (this.roster.members.length + this.pending.size >= P.MAX_PEERS) {
      return { ok: false, error: `This room is full (${P.MAX_PEERS} people).` };
    }
    const decoded = this.invites.decode(text, 'invite');
    if (!decoded.ok) return decoded;
    const { invite } = decoded;
    if (invite.pubKey === this.selfKey) return { ok: false, error: 'That invite is your own.' };
    if (this.roster.members.includes(invite.pubKey)) return { ok: false, error: `${invite.name} is already in this room.` };
    return { ok: true, invite: { pubKey: invite.pubKey, name: invite.name, sdp: invite.sdp } };
  }

  /** Member, step 3: wrap the renderer's answer SDP as a signed reply blob. */
  makeReply(sdp) {
    if (this.status !== 'active') return { ok: false, error: 'Create or join a room first.' };
    return { ok: true, reply: this.invites.encode({ kind: 'reply', roomId: this.roster.roomId, name: this.selfName, sdp }) };
  }

  /** Joiner, step 4: check the pasted reply. The renderer then completes the connection. */
  openReply(text) {
    if (this.status !== 'joining') return { ok: false, error: 'Create an invite first.' };
    const decoded = this.invites.decode(text, 'reply');
    if (!decoded.ok) return decoded;
    const { invite: reply } = decoded;
    if (!reply.roomId) return { ok: false, error: 'That reply has no room in it.' };
    this.joining = { introducerKey: reply.pubKey, roomId: reply.roomId, since: this.now() };
    this.error = null;
    this.emitState();
    return { ok: true, reply: { sdp: reply.sdp, pubKey: reply.pubKey, roomId: reply.roomId, name: reply.name } };
  }

  // -------------------------------------------------------------- channels

  /**
   * The renderer reports a data channel is open.
   *  - 'admit': we answered an invite; `peerKey` is the joiner. Quarantined.
   *  - 'joiner': we sent the invite; `peerKey` is the member who replied.
   *  - 'relay': a mesh connection to a roster member, negotiated over the mesh.
   */
  channelOpen({ channelId, mode, peerKey }) {
    const now = this.now();
    if (mode === 'admit') {
      if (this.status !== 'active') return this.emit('close', { channelId });
      this.channels.set(channelId, { id: channelId, key: peerKey, state: 'quarantined' });
      return;
    }
    if (mode === 'joiner') {
      if (this.status !== 'joining' || !this.joining || this.joining.introducerKey !== peerKey) {
        return this.emit('close', { channelId });
      }
      this.channels.set(channelId, { id: channelId, key: peerKey, state: 'joining' });
      this.sendTo(channelId, this.sign('join-request', {
        name: this.selfName,
        pubKey: this.selfKey,
        introducer: peerKey,
      }));
      return;
    }
    if (mode === 'relay' && this.status === 'active' && this.roster.members.includes(peerKey) && !this.byKey.has(peerKey)) {
      this.channels.set(channelId, { id: channelId, key: peerKey, state: 'active' });
      this.byKey.set(peerKey, channelId);
      this.lastSeen.set(peerKey, now);
      this.emitState();
      return;
    }
    this.emit('close', { channelId });
  }

  channelClosed(channelId) {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    const wasJoining = channel.state === 'joining';
    this.channels.delete(channelId);
    if (channel.key && this.byKey.get(channel.key) === channelId) this.byKey.delete(channel.key);
    for (const [key, entry] of this.pending) {
      if (entry.channelId === channelId) this.pending.delete(key);
    }
    if (wasJoining && this.status === 'joining') {
      this.fail('The connection to the room was lost before you were admitted.');
      return;
    }
    this.emitState();
  }

  // -------------------------------------------------------------- inbound

  /** One string off a data channel. Anything that does not check out is dropped silently. */
  handleData(channelId, data) {
    const channel = this.channels.get(channelId);
    if (!channel || channel.state === 'denied') return;
    if (typeof data !== 'string' || data.length > MAX_FRAME_CHARS) return;

    let frame;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (!this.auth.verifyFrame(frame).ok) return;
    const now = this.now();

    if (channel.state === 'quarantined') {
      if (P.allowedWhileQuarantined(frame) && frame.from === channel.key) this.onQuarantinedJoinRequest(channel, frame);
      return;
    }
    if (DIRECT_ONLY.has(frame.type) && frame.from !== channel.key) return;
    if (channel.state === 'joining') {
      this.onJoiningFrame(channel, frame, data);
      return;
    }

    if (this.status !== 'active' || !this.roster.members.includes(frame.from)) return;
    if (frame.from === channel.key) {
      this.lastSeen.set(channel.key, now);
      if (frame.from === this.roster.hostKey) {
        this.hostHeardAt = now;
        this.hostLinked = true;
      }
    }

    switch (frame.type) {
      case 'roster':
      case 'host-claim':
        this.onAuthority(frame, data, channel);
        break;
      case 'timer-state':
        this.onTimerState(frame, data);
        break;
      case 'signal-relay':
        this.onSignalRelay(frame, data, channel);
        break;
      case 'join-request':
        this.onForwardedJoinRequest(frame);
        break;
      case 'join-deny':
        this.onJoinDeny(frame);
        break;
      case 'ping':
        this.onPing(frame, channel);
        break;
      case 'pong':
        this.onPong(frame, now);
        break;
      case 'chat':
        this.onChat(frame, now);
        break;
      case 'leave':
        this.onLeave(frame, channel);
        break;
      default:
        break; // heartbeat: liveness was recorded above
    }
  }

  // ----------------------------------------------------- admission (member side)

  onQuarantinedJoinRequest(channel, frame) {
    if (this.status !== 'active') return;
    const body = frame.body;
    const joiner = frame.from;
    if (body.pubKey !== joiner || body.introducer !== this.selfKey) return;
    if (this.pending.has(joiner) || this.pending.size >= MAX_PENDING) return;

    this.pending.set(joiner, { key: joiner, name: body.name, introducer: this.selfKey, channelId: channel.id, at: this.now() });

    if (this.isHost) {
      const gate = P.canAdmit({ roster: this.roster, joinerKey: joiner, requestedAt: this.now(), now: this.now() });
      if (!gate.ok) return this.denyPending(joiner);
      this.emitState();
      return;
    }
    const hostChannel = this.byKey.get(this.roster.hostKey);
    if (!hostChannel) return this.denyPending(joiner);
    this.sendTo(hostChannel, this.sign('join-request', { name: body.name, pubKey: joiner, introducer: this.selfKey }));
    this.emitState();
  }

  /** Host only: an introducer vouches for a stranger on the far side of its own channel. */
  onForwardedJoinRequest(frame) {
    if (!this.isHost) return;
    const body = frame.body;
    if (body.introducer !== frame.from || this.pending.has(body.pubKey) || this.pending.size >= MAX_PENDING) return;
    const gate = P.canAdmit({ roster: this.roster, joinerKey: body.pubKey, requestedAt: this.now(), now: this.now() });
    if (!gate.ok) {
      const introducerChannel = this.byKey.get(frame.from);
      if (introducerChannel) this.sendTo(introducerChannel, this.sign('join-deny', { joiner: body.pubKey }));
      return;
    }
    this.pending.set(body.pubKey, { key: body.pubKey, name: body.name, introducer: frame.from, channelId: null, at: this.now() });
    this.emitState();
  }

  /** The host said no. The introducer passes the verdict to the stranger and hangs up. */
  onJoinDeny(frame) {
    if (frame.from !== this.roster.hostKey) return;
    this.denyPending(frame.body.joiner, { fromHost: true });
  }

  denyPending(joinerKey, { fromHost = false } = {}) {
    const entry = this.pending.get(joinerKey);
    this.pending.delete(joinerKey);
    if (entry && entry.channelId) {
      const channel = this.channels.get(entry.channelId);
      if (channel) {
        this.sendTo(channel.id, this.sign('join-deny', { joiner: joinerKey }));
        channel.state = 'denied';
        channel.closeAt = this.now() + DENY_FLUSH_MS;
      }
    } else if (entry && !fromHost && this.isHost) {
      const introducerChannel = this.byKey.get(entry.introducer);
      if (introducerChannel) this.sendTo(introducerChannel, this.sign('join-deny', { joiner: joinerKey }));
    }
    this.emitState();
  }

  /** Host: let a pending joiner in and publish the new roster. */
  approve(joinerKey) {
    if (!this.isHost) return { ok: false, error: 'Only the host can admit people.' };
    const entry = this.pending.get(joinerKey);
    if (!entry) return { ok: false, error: 'That request is no longer pending.' };
    const gate = P.canAdmit({ roster: this.roster, joinerKey, requestedAt: entry.at, now: this.now() });
    if (!gate.ok) {
      this.denyPending(joinerKey);
      return { ok: false, error: gate.error };
    }
    this.pending.delete(joinerKey);
    this.admittedAt.set(joinerKey, this.now());
    this.publishRoster({
      members: [...this.roster.members, joinerKey],
      names: { ...this.roster.names, [joinerKey]: entry.name },
    });
    if (entry.introducer === this.selfKey) this.promote(entry);
    return { ok: true };
  }

  deny(joinerKey) {
    if (!this.isHost) return { ok: false, error: 'Only the host can decline people.' };
    this.denyPending(joinerKey);
    return { ok: true };
  }

  /** The stranger is a member now: open the quarantined channel and catch them up. */
  promote(entry) {
    const channel = this.channels.get(entry.channelId);
    if (!channel || channel.state !== 'quarantined') return;
    channel.state = 'active';
    this.byKey.set(channel.key, channel.id);
    this.lastSeen.set(channel.key, this.now());
    this.sendTo(channel.id, this.authorityRaw);
    if (this.timerRaw) this.sendTo(channel.id, this.timerRaw);
  }

  // ------------------------------------------------------ admission (joiner side)

  onJoiningFrame(channel, frame, raw) {
    if (frame.type === 'join-deny' && frame.body.joiner === this.selfKey) {
      this.fail('The host declined your request to join.');
      return;
    }
    if (frame.type !== 'roster' && frame.type !== 'host-claim') return;

    const roster = frame.type === 'roster' ? frame.body : frame.body.roster;
    const signedByHost = frame.from === roster.hostKey && (frame.type === 'roster' || frame.body.hostKey === roster.hostKey);
    if (!signedByHost || !P.validateRoster(roster).ok) return;
    if (roster.roomId !== this.joining.roomId || !roster.members.includes(this.selfKey)) return;

    // The first roster that lists us, brought by the member whose reply we
    // pasted, is the trust anchor: we have no earlier roster to check it against.
    this.status = 'active';
    this.roster = roster;
    this.authorityRaw = raw;
    this.joining = null;
    channel.state = 'active';
    this.byKey.set(channel.key, channel.id);
    const now = this.now();
    this.lastSeen.set(channel.key, now);
    this.hostHeardAt = now;
    this.timer.becomeFollower({ offsetMs: 0 });
    this.emit('joined');
    for (const key of roster.members) {
      if (key !== this.selfKey && key !== channel.key) this.emit('relay-connect', { peerKey: key });
    }
    this.emitState();
  }

  fail(message) {
    const wasJoining = this.status === 'joining';
    this.closeAll();
    this.reset();
    this.error = message;
    if (wasJoining) this.status = 'idle';
    this.emitState();
  }

  // ------------------------------------------------------------- authority

  /** A roster or a host claim: adopt it only if acceptRoster allows. */
  onAuthority(frame, raw, channel) {
    const isClaim = frame.type === 'host-claim';
    const roster = isClaim ? frame.body.roster : frame.body;
    if (isClaim && frame.body.hostKey !== roster.hostKey) return;

    const current = { ...this.roster };
    const verdict = P.acceptRoster({
      roster,
      signer: frame.from,
      current,
      claim: isClaim ? { hostKey: frame.body.hostKey, hostSeq: frame.body.hostSeq } : undefined,
      connectedKeys: this.connectedKeys(),
    });
    if (!verdict.ok) return;
    this.adoptRoster(roster, raw, channel);
  }

  adoptRoster(roster, raw, fromChannel) {
    const wasHost = this.isHost;
    const hostChanged = roster.hostKey !== this.roster.hostKey;
    this.roster = roster;
    this.authorityRaw = raw;

    if (wasHost && roster.hostKey !== this.selfKey) {
      this.timer.becomeFollower({ offsetMs: 0 });
      this.timerRaw = null;
      this.pending.clear();
    }
    if (hostChanged) {
      this.samples = [];
      this.hostHeardAt = this.now();
      this.hostLinked = this.byKey.has(roster.hostKey);
      this.lastPingAt = 0;
    }

    // Anyone the new roster does not list is out: a merge loser's strays, or a
    // member the host pruned.
    for (const channel of [...this.channels.values()]) {
      if (channel.state === 'active' && !roster.members.includes(channel.key)) this.closeChannel(channel.id);
    }
    // Strangers we were introducing are members now.
    for (const [key, entry] of [...this.pending]) {
      if (roster.members.includes(key)) {
        this.pending.delete(key);
        if (entry.introducer === this.selfKey) this.promote(entry);
      }
    }
    this.emitState();
  }

  /** Host: publish a changed roster to everyone. */
  publishRoster({ members, names }) {
    const live = new Set(members);
    const trimmed = Object.fromEntries(Object.entries(names).filter(([key]) => live.has(key)));
    this.roster = { ...this.roster, rosterSeq: this.roster.rosterSeq + 1, members, names: trimmed };
    this.authorityRaw = this.sign('roster', this.roster);
    this.broadcastRaw(this.authorityRaw);
    this.emitState();
  }

  /** Follower: the host has been silent long enough and we are next in line. */
  claimHost() {
    const reachable = new Set(this.connectedKeys());
    const members = this.roster.members.filter((key) => reachable.has(key)).sort();
    const roster = {
      roomId: this.roster.roomId,
      rosterSeq: this.roster.rosterSeq + 1,
      hostSeq: this.roster.hostSeq + 1,
      hostKey: this.selfKey,
      members,
      names: Object.fromEntries(Object.entries(this.roster.names || {}).filter(([key]) => reachable.has(key))),
    };
    this.roster = roster;
    this.pending.clear();
    this.samples = [];
    this.authorityRaw = this.sign('host-claim', { hostKey: this.selfKey, hostSeq: roster.hostSeq, roster });
    // The claim goes out first: peers drop a timer state whose hostSeq they have not adopted yet.
    this.broadcastRaw(this.authorityRaw);
    this.timer.becomeHost({ hostSeq: roster.hostSeq });
    this.emitState();
  }

  connectedKeys() {
    const now = this.now();
    const keys = [this.selfKey];
    for (const [key] of this.byKey) {
      if (now - (this.lastSeen.get(key) || 0) < P.HOST_LOST_MS) keys.push(key);
    }
    return keys;
  }

  // ------------------------------------------------------------------ timer

  onTimerBroadcast(state) {
    if (!this.isHost) return;
    this.timerRaw = this.sign('timer-state', state);
    this.lastTimerBody = state;
    this.broadcastRaw(this.timerRaw);
  }

  onTimerState(frame, raw) {
    if (this.isHost || frame.from !== this.roster.hostKey) return;
    const body = frame.body;
    if (body.hostSeq !== this.roster.hostSeq || P.isStaleTimerState(body, this.lastTimerBody)) return;
    this.lastTimerBody = body;
    this.timerRaw = raw;
    // Before a ping/pong has measured the link, the host's own timestamp on
    // the frame gives an offset that is off by only the one-way latency.
    const offsetMs = this.samples.length === 0 ? frame.ts - this.now() : undefined;
    this.timer.applyRemote(body, offsetMs);
  }

  onPing(frame, channel) {
    if (!this.pingLimiter.allow(frame.from, this.now())) return;
    const t1 = this.now();
    this.sendTo(channel.id, this.sign('pong', { t0: frame.body.t0, t1, t2: this.now() }));
  }

  onPong(frame, now) {
    if (frame.from !== this.roster.hostKey) return;
    const { t0, t1, t2 } = frame.body;
    if (now - t0 > 30000 || t0 > now) return;
    this.samples.push({ t0, t1, t2, t3: now });
    if (this.samples.length > CLOCK_SAMPLES) this.samples.shift();
    const estimate = P.estimateOffset(this.samples);
    if (estimate) this.timer.setOffset(estimate.offsetMs);
  }

  // ------------------------------------------------------------ mesh signaling

  /** Renderer -> mesh: an SDP for a peer we are not directly connected to yet. */
  relayOut({ to, kind, sdp }) {
    if (this.status !== 'active' || !this.roster.members.includes(to)) return { ok: false };
    const raw = this.sign('signal-relay', { to, origin: this.selfKey, kind, sdp });
    const via = this.byKey.get(to) || this.routeFor(to);
    if (!via) return { ok: false };
    this.sendTo(via, raw);
    return { ok: true };
  }

  routeFor(key) {
    const via = this.routes.get(key);
    return via && this.channels.has(via) ? via : this.introducerChannel();
  }

  /** The joiner's only connection right after admission is the member who let it in. */
  introducerChannel() {
    for (const id of this.byKey.values()) return id;
    return null;
  }

  onSignalRelay(frame, raw, channel) {
    const { to, origin } = frame.body;
    if (origin !== frame.from) return;
    // Relayed frames can be replayed by whoever carries them; direct ones cannot.
    const last = this.relaySeq.get(origin);
    if (last !== undefined && frame.seq <= last) return;
    this.relaySeq.set(origin, frame.seq);
    if (to === this.selfKey) {
      this.routes.set(origin, channel.id);
      this.emit('relay-signal', { origin, kind: frame.body.kind, sdp: frame.body.sdp });
      return;
    }
    // Forward verbatim: the signature is the originator's and cannot be altered.
    this.routes.set(origin, channel.id);
    const next = this.byKey.get(to);
    if (next && next !== channel.id) this.sendTo(next, raw);
  }

  // ------------------------------------------------------------------- chat

  sendChat(text) {
    if (this.status !== 'active') return { ok: false, error: 'You are not in a room.' };
    const clean = String(text || '').trim();
    if (!clean) return { ok: false, error: 'Empty message.' };
    if (P.validateFrame({ v: 1, type: 'chat', from: 'x', seq: 0, ts: 0, sig: 'x', body: { text: clean } }).ok !== true) {
      return { ok: false, error: `Messages are limited to ${P.CHAT_MAX_BYTES} bytes.` };
    }
    if (!this.chatLimiter.allow(this.selfKey, this.now())) return { ok: false, error: 'Slow down a little.' };
    const raw = this.sign('chat', { text: clean });
    this.pushChat(this.selfKey, clean, this.now());
    this.broadcastRaw(raw);
    this.emitState();
    return { ok: true };
  }

  onChat(frame, now) {
    if (!this.chatLimiter.allow(frame.from, now)) return;
    this.pushChat(frame.from, frame.body.text, now);
    this.emitState();
  }

  pushChat(from, text, ts) {
    this.chat.push({ from, name: this.nameOf(from), text, ts });
    if (this.chat.length > MAX_CHAT_LOG) this.chat.shift();
  }

  nameOf(key) {
    return (this.roster && this.roster.names && this.roster.names[key]) || `Guest ${key.slice(0, 4)}`;
  }

  // ------------------------------------------------------------------ leaving

  onLeave(frame, channel) {
    this.closeChannel(channel.id);
    this.lastSeen.delete(frame.from);
    if (frame.from === this.roster.hostKey) {
      this.hostHeardAt = 0; // the host said goodbye: no need to wait out the silence
      return;
    }
    if (this.isHost) this.pruneMembers([frame.from]);
    else this.emitState();
  }

  pruneMembers(keys) {
    const gone = new Set(keys);
    const members = this.roster.members.filter((key) => !gone.has(key));
    this.publishRoster({ members, names: this.roster.names || {} });
    for (const key of keys) {
      const id = this.byKey.get(key);
      if (id) this.closeChannel(id);
    }
  }

  /** Leaves the room and tells the others. Safe to call when not in one. */
  leave() {
    if (this.status === 'active') this.broadcastRaw(this.sign('leave', {}));
    const wasActive = this.status === 'active';
    this.closeAll();
    this.reset();
    this.timer.reset();
    if (wasActive) this.emit('left');
    this.emitState();
  }

  closeAll() {
    for (const id of [...this.channels.keys()]) this.closeChannel(id);
  }

  // --------------------------------------------------------------------- tick

  /** Heartbeats, clock pings, host handover, pruning and timeouts. Driven by a timer or a test. */
  tick() {
    const now = this.now();

    for (const channel of [...this.channels.values()]) {
      if (channel.state === 'denied' && now >= channel.closeAt) this.closeChannel(channel.id);
    }

    if (this.status === 'joining' && this.joining && now - this.joining.since > P.ADMISSION_TIMEOUT_MS + 5000) {
      this.fail('Nobody admitted you in time. Ask for a new invite.');
      return;
    }
    if (this.status !== 'active') return;

    let dirty = false;
    for (const [key, entry] of [...this.pending]) {
      if (now - entry.at > P.ADMISSION_TIMEOUT_MS) {
        this.denyPending(key);
        dirty = true;
      }
    }

    if (now - this.lastBeatAt >= P.HEARTBEAT_MS) {
      this.lastBeatAt = now;
      this.broadcastRaw(this.sign('heartbeat', { hostSeq: this.roster.hostSeq }));
      if (this.isHost && this.timer.snapshot()) {
        const raw = this.sign('timer-state', this.timer.snapshot());
        this.timerRaw = raw;
        this.broadcastRaw(raw);
      }
    }

    if (this.isHost) {
      const silent = this.roster.members.filter((key) => key !== this.selfKey && this.isSilent(key, now));
      if (silent.length > 0) {
        this.pruneMembers(silent);
        dirty = false;
      }
    } else {
      const hostChannel = this.byKey.get(this.roster.hostKey);
      if (hostChannel && now - this.lastPingAt >= (this.samples.length === 0 ? 2000 : PING_MS)) {
        this.lastPingAt = now;
        this.sendTo(hostChannel, this.sign('ping', { t0: now }));
      }
      // Only a host we once heard directly can go silent; a fresh joiner still
      // waiting on its mesh links must not mistake that for a dead host.
      if (this.hostLinked && P.shouldClaimHost({
        selfKey: this.selfKey,
        roster: this.roster,
        connectedKeys: this.connectedKeys(),
        lastHostHeardAt: this.hostHeardAt,
        now,
      })) {
        this.claimHost();
        return;
      }
    }
    if (dirty) this.emitState();
  }

  isSilent(key, now) {
    const seen = this.lastSeen.get(key);
    if (seen === undefined) {
      return now - (this.admittedAt.get(key) ?? this.createdAt) > NEVER_SEEN_GRACE_MS;
    }
    return now - seen > P.HOST_LOST_MS;
  }

  // -------------------------------------------------------------------- view

  emitState() {
    this.emit('state', this.view());
  }

  /** Everything the UI shows; contains no secrets. */
  view() {
    const now = this.now();
    const connected = new Set(this.connectedKeys());
    const roster = this.roster;
    return {
      status: this.status,
      waitingForHost: this.status === 'joining' && this.joining !== null,
      error: this.error,
      maxPeers: P.MAX_PEERS,
      selfKey: this.selfKey,
      selfName: this.selfName,
      roomId: roster ? roster.roomId : null,
      mnemonic: roster ? this.auth.mnemonic(roster.roomId) : null,
      isHost: this.isHost,
      hostKey: roster ? roster.hostKey : null,
      members: roster
        ? roster.members.map((key) => ({
            key,
            name: this.nameOf(key),
            isSelf: key === this.selfKey,
            isHost: key === roster.hostKey,
            connected: connected.has(key),
          }))
        : [],
      pending: [...this.pending.values()].map((entry) => ({
        key: entry.key,
        name: entry.name,
        fingerprint: this.auth.fingerprint(entry.key),
        introducerKey: entry.introducer,
        introducerName: this.nameOf(entry.introducer),
        introducedByMe: entry.introducer === this.selfKey,
        secondsLeft: Math.max(0, Math.ceil((P.ADMISSION_TIMEOUT_MS - (now - entry.at)) / 1000)),
      })),
      chat: this.chat.map((m) => ({ ...m, self: m.from === this.selfKey })),
    };
  }
}

module.exports = { RoomService };

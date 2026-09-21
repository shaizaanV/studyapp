'use strict';

/**
 * Pure decision logic for study rooms: frame validation, host ordering and
 * election, roster acceptance, clock offset and rate limiting.
 *
 * No Electron, no WebRTC, no crypto, no clock reads. Signature verification is
 * done by the caller (main-process RoomAuth) before these rules run, so every
 * function here takes plain data and returns plain data. It loads as a plain
 * <script> in the renderer (window.RoomProtocol) and via require() in main and
 * in node:test.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RoomProtocol = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const PROTOCOL_VERSION = 1;

  const MAX_PEERS = 12;
  const HEARTBEAT_MS = 2000;
  const HOST_LOST_MS = 8000;
  const ADMISSION_TIMEOUT_MS = 60000;
  const REJOIN_AFTER_MS = 60000;
  const INVITE_TTL_MS = 10 * 60000;
  const CHAT_MAX_BYTES = 2048;
  const CHAT_RATE_PER_SEC = 5;
  const MAX_NAME_LENGTH = 40;

  const MIN_DURATION_MS = 1000;
  const MAX_DURATION_MS = 4 * 60 * 60000;

  /** Rooms run Pomodoro focus and standard breaks only: no Flow, no Wall. */
  const ROOM_PHASES = ['IDLE', 'FOCUS', 'FOCUS_PAUSED', 'BREAK', 'BREAK_PAUSED', 'ALARM'];
  const RUNNING_PHASES = ['FOCUS', 'BREAK'];
  const PAUSED_PHASES = ['FOCUS_PAUSED', 'BREAK_PAUSED'];

  /** Actions a peer may ask the host for. The host decides whether to honour them. */
  const TIMER_ACTIONS = [
    'start', 'pause', 'resume', 'stop',
    'start-break', 'pause-break', 'resume-break', 'skip-break',
    'dismiss-alarm', 'continue-session',
  ];

  /** Frames that may cross a quarantined (not yet admitted) channel. */
  const QUARANTINE_ALLOWED = ['join-request'];

  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isNonEmptyString = (v, max = 256) => typeof v === 'string' && v.length > 0 && v.length <= max;
  const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
  const isDuration = (v) => Number.isFinite(v) && v >= MIN_DURATION_MS && v <= MAX_DURATION_MS;
  const byteLength = (s) => {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
    return Buffer.byteLength(s, 'utf8');
  };

  /** JSON with recursively sorted keys: the byte string that gets signed. */
  function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (isObject(value)) {
      const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }

  const ok = () => ({ ok: true });
  const bad = (error) => ({ ok: false, error });

  function validateRoster(roster) {
    if (!isObject(roster)) return bad('roster: not an object');
    if (!isNonEmptyString(roster.roomId, 64)) return bad('roster: roomId');
    if (!isCount(roster.rosterSeq) || !isCount(roster.hostSeq)) return bad('roster: seq');
    if (!isNonEmptyString(roster.hostKey)) return bad('roster: hostKey');
    if (!Array.isArray(roster.members) || roster.members.length === 0) return bad('roster: members');
    if (roster.members.length > MAX_PEERS) return bad('roster: over capacity');
    if (!roster.members.every((k) => isNonEmptyString(k))) return bad('roster: member key');
    if (new Set(roster.members).size !== roster.members.length) return bad('roster: duplicate member');
    if (!roster.members.includes(roster.hostKey)) return bad('roster: host not a member');
    if (roster.names !== undefined) {
      if (!isObject(roster.names)) return bad('roster: names');
      for (const [key, name] of Object.entries(roster.names)) {
        if (!roster.members.includes(key) || !isNonEmptyString(name, MAX_NAME_LENGTH)) return bad('roster: names');
      }
    }
    return ok();
  }

  function validateTimerState(body) {
    if (!isObject(body)) return bad('timer-state: not an object');
    if (!ROOM_PHASES.includes(body.phase)) return bad('timer-state: phase');
    if (!isCount(body.hostSeq) || !isCount(body.seq)) return bad('timer-state: seq');
    if (!isDuration(body.focusMs) || !isDuration(body.breakMs)) return bad('timer-state: durations');
    if (RUNNING_PHASES.includes(body.phase)) {
      if (!Number.isFinite(body.endsAtEpochMs)) return bad('timer-state: endsAtEpochMs');
    } else if (PAUSED_PHASES.includes(body.phase)) {
      if (!Number.isFinite(body.remainingMs) || body.remainingMs < 0) return bad('timer-state: remainingMs');
    }
    return ok();
  }

  const BODY_VALIDATORS = {
    'join-request': (b) =>
      isObject(b) && isNonEmptyString(b.name, MAX_NAME_LENGTH) && isNonEmptyString(b.pubKey) && isNonEmptyString(b.introducer)
        ? ok() : bad('join-request: body'),
    'join-deny': (b) => (isObject(b) && isNonEmptyString(b.joiner) ? ok() : bad('join-deny: body')),
    roster: (b) => validateRoster(b),
    'timer-state': validateTimerState,
    'timer-action': (b) =>
      isObject(b) && TIMER_ACTIONS.includes(b.action) ? ok() : bad('timer-action: action'),
    heartbeat: (b) => (isObject(b) && isCount(b.hostSeq) ? ok() : bad('heartbeat: body')),
    ping: (b) => (isObject(b) && Number.isFinite(b.t0) ? ok() : bad('ping: body')),
    pong: (b) =>
      isObject(b) && Number.isFinite(b.t0) && Number.isFinite(b.t1) && Number.isFinite(b.t2)
        ? ok() : bad('pong: body'),
    chat: (b) =>
      isObject(b) && typeof b.text === 'string' && b.text.length > 0 && byteLength(b.text) <= CHAT_MAX_BYTES
        ? ok() : bad('chat: text'),
    'signal-relay': (b) =>
      isObject(b) && isNonEmptyString(b.to) && isNonEmptyString(b.origin) &&
      ['offer', 'answer'].includes(b.kind) && typeof b.sdp === 'string' && b.sdp.length > 0 && b.sdp.length <= 16384
        ? ok() : bad('signal-relay: body'),
    'host-claim': (b) =>
      isObject(b) && isNonEmptyString(b.hostKey) && isCount(b.hostSeq)
        ? (() => { const r = validateRoster(b.roster); return r.ok ? ok() : r; })()
        : bad('host-claim: body'),
    leave: (b) => (isObject(b) ? ok() : bad('leave: body')),
  };

  /**
   * Shape check of a signed frame envelope: {v, type, from, seq, ts, body, sig}.
   * Says nothing about whether `sig` is valid; that is RoomAuth's job.
   */
  function validateFrame(frame) {
    if (!isObject(frame)) return bad('frame: not an object');
    if (frame.v !== PROTOCOL_VERSION) return bad('frame: version');
    const validator = BODY_VALIDATORS[frame.type];
    if (!validator) return bad('frame: unknown type');
    if (!isNonEmptyString(frame.from)) return bad('frame: from');
    if (!isCount(frame.seq)) return bad('frame: seq');
    if (!Number.isFinite(frame.ts)) return bad('frame: ts');
    if (!isNonEmptyString(frame.sig, 512)) return bad('frame: sig');
    return validator(frame.body);
  }

  /** Whether a frame may be processed on a channel that is still quarantined. */
  const allowedWhileQuarantined = (frame) => isObject(frame) && QUARANTINE_ALLOWED.includes(frame.type);

  /**
   * Orders two host claims. Positive means `a` dominates, negative means `b`
   * does. Higher hostSeq wins; equal hostSeq falls to the lower public key.
   */
  function compareHostClaims(a, b) {
    if (a.hostSeq !== b.hostSeq) return a.hostSeq - b.hostSeq;
    if (a.hostKey === b.hostKey) return 0;
    return a.hostKey < b.hostKey ? 1 : -1;
  }

  /** Lowest sorted key among roster members that are currently reachable. */
  function electHost(members, connectedKeys) {
    const connected = new Set(connectedKeys);
    const candidates = members.filter((k) => connected.has(k)).sort();
    return candidates.length > 0 ? candidates[0] : null;
  }

  /**
   * Should `selfKey` claim host now? True once the host has been silent for
   * HOST_LOST_MS and this peer is the elected candidate. `connectedKeys` must
   * include selfKey.
   */
  function shouldClaimHost({ selfKey, roster, connectedKeys, lastHostHeardAt, now }) {
    if (now - lastHostHeardAt < HOST_LOST_MS) return false;
    const reachable = connectedKeys.filter((k) => k !== roster.hostKey);
    return electHost(roster.members, reachable) === selfKey;
  }

  /**
   * Decides whether to accept `roster`, signed by `signer` (signature already
   * verified). `current` is the locally recognised {hostKey, hostSeq,
   * rosterSeq, members}. Three legitimate paths:
   *  - the current host publishes the next roster;
   *  - a migration claim: a roster carrying a higher hostSeq, signed by the
   *    lowest key the acceptor can currently reach among the last roster's
   *    members (the departing host excluded). "Active" is judged from the
   *    acceptor's own view, since a peer's claim of being lowest is unverifiable.
   *    `connectedKeys` defaults to every member when the view is unknown;
   *  - a merge tie: at equal hostSeq, a member with the lower key beats the
   *    local host in compareHostClaims.
   */
  function acceptRoster({ roster, signer, current, claim, connectedKeys }) {
    const shape = validateRoster(roster);
    if (!shape.ok) return shape;
    if (roster.hostKey !== signer) return bad('roster: not signed by its host');
    if (roster.roomId !== current.roomId) return bad('roster: wrong room');

    if (signer === current.hostKey && roster.hostSeq === current.hostSeq) {
      return roster.rosterSeq > current.rosterSeq ? ok() : bad('roster: stale rosterSeq');
    }

    if (!current.members.includes(signer)) return bad('roster: signer not in last roster');

    if (!claim || claim.hostKey !== signer || claim.hostSeq !== roster.hostSeq) {
      return bad('roster: no legitimate authority');
    }

    if (roster.hostSeq > current.hostSeq) {
      const reachable = (connectedKeys || current.members).filter((k) => k !== current.hostKey);
      return electHost(current.members, reachable) === signer ? ok() : bad('roster: signer is not the lowest active key');
    }

    if (roster.hostSeq === current.hostSeq && compareHostClaims({ hostKey: signer, hostSeq: roster.hostSeq }, current) > 0) {
      return ok();
    }
    return bad('roster: no legitimate authority');
  }

  /**
   * Split-brain resolution. Returns 'keep' when the local claim dominates and
   * 'adopt' when the remote one does (the local side then takes the remote
   * clock and roster wholesale).
   */
  function resolveMerge(local, remote) {
    return compareHostClaims(local, remote) >= 0 ? 'keep' : 'adopt';
  }

  /** Members of the losing roster that the winning roster does not know. */
  const unmergedJoiners = (loserRoster, winnerRoster) =>
    loserRoster.members.filter((k) => !winnerRoster.members.includes(k));

  /**
   * NTP-style offset from one round trip: t0 local send, t1 host receive,
   * t2 host send, t3 local receive. offsetMs = hostClock - localClock.
   */
  function clockSample({ t0, t1, t2, t3 }) {
    return {
      offsetMs: ((t1 - t0) + (t2 - t3)) / 2,
      rttMs: (t3 - t0) - (t2 - t1),
    };
  }

  /** The lowest-RTT sample is the least distorted by queueing. */
  function estimateOffset(samples) {
    if (samples.length === 0) return null;
    return samples.map(clockSample).reduce((best, s) => (s.rttMs < best.rttMs ? s : best));
  }

  /** Milliseconds left on a shared timer state, on this peer's own clock. */
  function remainingMs(state, localNow, offsetMs) {
    if (RUNNING_PHASES.includes(state.phase)) {
      return Math.max(0, state.endsAtEpochMs - (localNow + offsetMs));
    }
    if (PAUSED_PHASES.includes(state.phase)) return state.remainingMs;
    return 0;
  }

  /** True when `incoming` must be ignored because `latest` supersedes it. */
  function isStaleTimerState(incoming, latest) {
    if (!latest) return false;
    if (incoming.hostSeq !== latest.hostSeq) return incoming.hostSeq < latest.hostSeq;
    return incoming.seq <= latest.seq;
  }

  /**
   * Per-sender token bucket: CHAT_RATE_PER_SEC messages per second with a burst
   * of the same size. Time is passed in so tests stay deterministic.
   */
  function createRateLimiter({ perSecond = CHAT_RATE_PER_SEC } = {}) {
    const buckets = new Map();
    return {
      allow(key, now) {
        const bucket = buckets.get(key) || { tokens: perSecond, at: now };
        bucket.tokens = Math.min(perSecond, bucket.tokens + ((now - bucket.at) / 1000) * perSecond);
        bucket.at = now;
        const allowed = bucket.tokens >= 1;
        if (allowed) bucket.tokens -= 1;
        buckets.set(key, bucket);
        return allowed;
      },
      forget(key) {
        buckets.delete(key);
      },
    };
  }

  /** Whether a disconnected peer that just woke should leave and prompt a rejoin. */
  const shouldLeaveAfterWake = (disconnectedForMs) => disconnectedForMs > REJOIN_AFTER_MS;

  /** Host-side admission gate: is there room, and is the request still fresh? */
  function canAdmit({ roster, joinerKey, requestedAt, now }) {
    if (roster.members.includes(joinerKey)) return bad('admit: already a member');
    if (roster.members.length >= MAX_PEERS) return bad('admit: room full');
    if (now - requestedAt > ADMISSION_TIMEOUT_MS) return bad('admit: request timed out');
    return ok();
  }

  return {
    PROTOCOL_VERSION,
    MAX_PEERS,
    HEARTBEAT_MS,
    HOST_LOST_MS,
    ADMISSION_TIMEOUT_MS,
    REJOIN_AFTER_MS,
    INVITE_TTL_MS,
    CHAT_MAX_BYTES,
    CHAT_RATE_PER_SEC,
    MAX_NAME_LENGTH,
    ROOM_PHASES,
    TIMER_ACTIONS,
    canonicalJson,
    validateFrame,
    validateRoster,
    validateTimerState,
    allowedWhileQuarantined,
    compareHostClaims,
    electHost,
    shouldClaimHost,
    acceptRoster,
    resolveMerge,
    unmergedJoiners,
    clockSample,
    estimateOffset,
    remainingMs,
    isStaleTimerState,
    createRateLimiter,
    shouldLeaveAfterWake,
    canAdmit,
  };
});

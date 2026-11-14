'use strict';

const { DirectoryCore, RoomCore } = require('../../relay/src/core');

/**
 * The relay, in memory: real DirectoryCore and RoomCore behind a fake
 * WebSocket, so RelayClient and RoomLink run against the real routing, rate
 * limiting and signature checks. Time is a controllable clock.
 */
function createFakeRelay({ policy = { minApp: '5.0.0', proto: 2 }, start = 1_800_000_000_000 } = {}) {
  let time = start;
  const timers = [];
  const now = () => time;
  const schedule = (ms, fn) => {
    const timer = { at: time + ms, fn, live: true };
    timers.push(timer);
    return () => { timer.live = false; };
  };
  const dir = new DirectoryCore({ now });
  const rooms = new Map();
  let nextId = 1;
  const relay = { ip: '10.0.0.1', dir, rooms, policy };

  function runTimers() {
    for (const timer of [...timers]) {
      if (timer.live && timer.at <= time) {
        timer.live = false;
        timer.fn();
      }
    }
  }

  relay.advance = (ms) => {
    time += ms;
    runTimers();
  };

  function roomFor(roomId, code) {
    let room = rooms.get(roomId);
    if (!room) {
      room = new RoomCore({
        roomId, code, policy, now, schedule,
        rotateCode: async (id) => dir.rotate(id),
        releaseRoom: async (id) => { dir.release(id); rooms.delete(id); },
      });
      rooms.set(roomId, room);
    }
    return room;
  }

  class FakeWebSocket {
    constructor(url) {
      this.handlers = { open: [], message: [], close: [], error: [] };
      this.closed = false;
      this.ip = relay.ip;
      const parsed = new URL(url.replace(/^ws/, 'http'));
      const intent = parsed.searchParams.get('intent');
      setImmediate(() => this.route(intent, parsed.searchParams));
    }

    addEventListener(type, fn) {
      this.handlers[type].push(fn);
    }

    emit(type, event = {}) {
      for (const fn of this.handlers[type]) fn(event);
    }

    reject(error) {
      this.emit('open');
      setImmediate(() => {
        this.emit('message', { data: JSON.stringify({ t: 'err', ...error }) });
        this.shutdown();
      });
    }

    route(intent, params) {
      let room;
      if (intent === 'create') {
        const made = dir.create(this.ip, params.get('room'));
        if (made.error) return this.reject({ code: made.error, retryAfterS: made.retryAfterS });
        room = roomFor(made.roomId, made.code);
      } else if (intent === 'join') {
        const found = dir.lookup(params.get('code'), this.ip);
        if (found.error) return this.reject({ code: found.error, retryAfterS: found.retryAfterS });
        room = rooms.get(found.roomId);
        if (!room) return this.reject({ code: 'closed' });
      } else if (intent === 'member') {
        room = rooms.get(params.get('room'));
        if (!room) return this.reject({ code: 'closed' });
      } else {
        return this.reject({ code: 'invalid' });
      }

      this.room = room;
      this.conn = {
        id: `s${nextId++}`,
        ipHash: `${this.ip}|${room.roomId}`,
        state: { role: 'new', pubKey: null, authed: false },
        send: (obj) => setImmediate(() => { if (!this.closed) this.emit('message', { data: JSON.stringify(obj) }); }),
        close: () => setImmediate(() => this.shutdown()),
      };
      room.addConn(this.conn);
      this.emit('open');
    }

    send(data) {
      if (this.closed || !this.conn) return;
      setImmediate(() => {
        let msg;
        try { msg = JSON.parse(data); } catch { return; } // a bare keepalive 'ping'
        this.room.onMessage(this.conn, msg);
      });
    }

    close() {
      this.shutdown();
    }

    shutdown() {
      if (this.closed) return;
      this.closed = true;
      if (this.room && this.conn) this.room.removeConn(this.conn);
      this.emit('close');
    }
  }

  relay.WebSocket = FakeWebSocket;
  relay.fetch = async () => ({ json: async () => ({ ...policy, status: 'ok' }) });
  return relay;
}

module.exports = { createFakeRelay };

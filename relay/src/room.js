import { DurableObject } from 'cloudflare:workers';
import core from './core.js';

const { RoomCore } = core;
const MAX_MESSAGE_CHARS = 48 * 1024;

/**
 * One study room's signaling socket hub, on the WebSocket Hibernation API:
 * idle sockets cost nothing, and every message wakes the object, rebuilds the
 * connection wrapper from the socket's attachment, and hands it to RoomCore.
 */
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.core = null;
    this.conns = new Map(); // socket id -> conn
    this.alarmCancel = null;
    // Keepalive pings from clients are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  directory(path, body) {
    const stub = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName('main'));
    return stub.fetch(`https://directory${path}`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
  }

  async ensureCore(roomId, code) {
    if (this.core) return this.core;
    const snapshot = await this.ctx.storage.get('snap');
    this.core = new RoomCore({
      roomId,
      code: (snapshot && snapshot.code) || code,
      policy: { minApp: this.env.MIN_APP, proto: Number(this.env.PROTO) },
      snapshot,
      rotateCode: (id) => this.directory('/rotate', { roomId: id }),
      releaseRoom: async (id) => {
        await this.directory('/release', { roomId: id });
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
        this.core = null;
      },
      schedule: (ms, fn, opts = {}) => {
        if (opts.durable) {
          this.ctx.storage.setAlarm(Date.now() + ms);
          return () => this.ctx.storage.deleteAlarm();
        }
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
    });
    this.core.roomId = roomId;
    // After a hibernation, sockets are still open but the core has forgotten them.
    for (const ws of this.ctx.getWebSockets()) this.attach(ws);
    return this.core;
  }

  /** Wraps an accepted socket as a core connection, restoring its state from the attachment. */
  attach(ws) {
    const saved = ws.deserializeAttachment() || {};
    const id = saved.id || crypto.randomUUID();
    if (this.conns.has(id)) return this.conns.get(id);
    const conn = {
      id,
      ipHash: saved.ipHash || '',
      state: saved.state || { role: 'new', pubKey: null, authed: false },
      send: (obj) => { try { ws.send(JSON.stringify(obj)); } catch { /* socket already gone */ } },
      close: () => { try { ws.close(1000, 'done'); } catch { /* socket already gone */ } },
    };
    this.conns.set(id, conn);
    this.core.conns.set(id, conn);
    ws.serializeAttachment({ id, ipHash: conn.ipHash, state: conn.state });
    return conn;
  }

  persistAttachment(ws, conn) {
    const { pendingRoster, nonce, ...state } = conn.state; // attachments are capped at 2 KB
    ws.serializeAttachment({ id: conn.id, ipHash: conn.ipHash, state });
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    await this.ensureCore(request.headers.get('x-room-id'), request.headers.get('x-code') || '');
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: crypto.randomUUID(), ipHash: request.headers.get('x-ip-hash') || '', state: { role: 'new', pubKey: null, authed: false } });
    const conn = this.attach(server);
    this.core.addConn(conn);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string' || message.length > MAX_MESSAGE_CHARS) return;
    const roomId = this.core ? this.core.roomId : (await this.ctx.storage.get('snap'))?.roomId;
    if (!this.core) await this.ensureCore(roomId || '', '');
    if (!this.core) return;
    const conn = this.attach(ws);
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    await this.core.onMessage(conn, msg);
    if (this.core) {
      this.persistAttachment(ws, conn);
      await this.ctx.storage.put('snap', { ...this.core.snapshot(), roomId: this.core.roomId });
    }
  }

  async webSocketClose(ws) {
    this.dropSocket(ws);
  }

  async webSocketError(ws) {
    this.dropSocket(ws);
  }

  dropSocket(ws) {
    const saved = ws.deserializeAttachment() || {};
    const conn = this.conns.get(saved.id);
    this.conns.delete(saved.id);
    if (conn && this.core) this.core.removeConn(conn);
  }

  /** The empty-room grace period ended: close the room if nobody came back. */
  async alarm() {
    if (!this.core) {
      const snap = await this.ctx.storage.get('snap');
      if (!snap) return;
      await this.ensureCore(snap.roomId || '', '');
    }
    this.core.emptyCheck();
  }
}

'use strict';

/**
 * The room relay on plain Node, for development and the end-to-end check: the
 * same DirectoryCore / RoomCore the Cloudflare Worker runs, behind a minimal
 * RFC 6455 WebSocket server (no dependencies). Not for production.
 *
 *   node tools/local-relay.js [port]        then:  FLOWCUS_RELAY_URL=ws://127.0.0.1:8787 npm start
 */
const crypto = require('node:crypto');
const http = require('node:http');

const { DirectoryCore, RoomCore } = require('../relay/src/core');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(text) {
  const payload = Buffer.from(text);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Pulls complete frames off `buffer`. Returns {frames, rest}; frames are {opcode, payload}. */
function decodeFrames(buffer) {
  const frames = [];
  let at = 0;
  while (buffer.length - at >= 2) {
    const opcode = buffer[at] & 0x0f;
    const masked = (buffer[at + 1] & 0x80) !== 0;
    let length = buffer[at + 1] & 0x7f;
    let offset = at + 2;
    if (length === 126) {
      if (buffer.length - offset < 2) break;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length - offset < 8) break;
      length = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }
    const maskBytes = masked ? 4 : 0;
    if (buffer.length - offset < maskBytes + length) break;
    const mask = masked ? buffer.subarray(offset, offset + 4) : null;
    const payload = Buffer.from(buffer.subarray(offset + maskBytes, offset + maskBytes + length));
    if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    frames.push({ opcode, payload });
    at = offset + maskBytes + length;
  }
  return { frames, rest: buffer.subarray(at) };
}

function startLocalRelay({ port = 8787, policy = { minApp: '0.0.0', proto: require('../src/shared/room-protocol').PROTOCOL_VERSION } } = {}) {
  const dir = new DirectoryCore();
  const rooms = new Map();
  let nextId = 1;

  const roomFor = (roomId, code) => {
    let room = rooms.get(roomId);
    if (!room) {
      room = new RoomCore({
        roomId, code, policy,
        rotateCode: async (id) => dir.rotate(id),
        releaseRoom: async (id) => { dir.release(id); rooms.delete(id); },
      });
      rooms.set(roomId, room);
    }
    return room;
  };

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/info')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...policy, status: 'ok' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://local');
    const key = req.headers['sec-websocket-key'];
    if (url.pathname !== '/v1/ws' || !key) return socket.destroy();
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${crypto.createHash('sha1').update(key + GUID).digest('base64')}\r\n\r\n`
    );

    const ip = socket.remoteAddress || 'local';
    const send = (obj) => { if (!socket.destroyed) socket.write(encodeFrame(JSON.stringify(obj))); };
    const reject = (error) => { send({ t: 'err', ...error }); socket.end(); };

    const intent = url.searchParams.get('intent');
    let room;
    if (intent === 'create') {
      const made = dir.create(ip, url.searchParams.get('room'));
      if (made.error) return reject({ code: made.error, retryAfterS: made.retryAfterS });
      room = roomFor(made.roomId, made.code);
    } else if (intent === 'join') {
      const found = dir.lookup(url.searchParams.get('code'), ip);
      if (found.error) return reject({ code: found.error, retryAfterS: found.retryAfterS });
      room = rooms.get(found.roomId);
    } else if (intent === 'member') {
      room = rooms.get(url.searchParams.get('room'));
    }
    if (!room) return reject({ code: 'closed' });

    const conn = {
      id: `s${nextId++}`,
      ipHash: `${ip}|${room.roomId}`,
      state: { role: 'new', pubKey: null, authed: false },
      send,
      close: () => socket.end(),
    };
    room.addConn(conn);

    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      const parsed = decodeFrames(Buffer.concat([pending, chunk]));
      pending = parsed.rest;
      for (const frame of parsed.frames) {
        if (frame.opcode === 0x8) return socket.end();
        if (frame.opcode === 0x9) socket.write(Buffer.concat([Buffer.from([0x8a, frame.payload.length]), frame.payload]));
        if (frame.opcode === 0x1) {
          try {
            room.onMessage(conn, JSON.parse(frame.payload.toString('utf8')));
          } catch { /* ignore malformed JSON */ }
        }
      }
    });
    socket.on('close', () => room.removeConn(conn));
    socket.on('error', () => {});
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ url: `ws://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)), rooms, dir });
    });
  });
}

module.exports = { startLocalRelay };

if (require.main === module) {
  startLocalRelay({ port: Number(process.argv[2]) || 8787 }).then(({ url }) => console.log(`[relay] listening on ${url}`));
}

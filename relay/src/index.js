import { Directory } from './directory.js';
import { Room } from './room.js';

export { Directory, Room };

const JSON_HEADERS = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };

/** HMAC-SHA256 of `text` under the IP_SECRET, hex truncated to 16 bytes. Only hashes are ever stored. */
async function keyedHash(secret, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
  return [...mac.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** IPv6 addresses are bucketed by /64 so a single user cannot rotate through the host part. */
function ipBucket(ip) {
  if (!ip.includes(':')) return ip;
  return ip.split(':').slice(0, 4).join(':');
}

/** Accepts the WebSocket, sends one error message and closes: the client gets a reason, not a bare failure. */
function rejectSocket(error) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  server.send(JSON.stringify({ t: 'err', ...error }));
  server.close(1000, 'rejected');
  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/v1/info') {
      return new Response(JSON.stringify({
        minApp: env.MIN_APP, proto: Number(env.PROTO), status: env.RELAY_DISABLED === 'true' ? 'disabled' : 'ok',
      }), { headers: JSON_HEADERS });
    }

    if (url.pathname !== '/v1/ws') return new Response('Not found', { status: 404 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    if (env.RELAY_DISABLED === 'true') return rejectSocket({ code: 'disabled' });
    if (!env.IP_SECRET) return rejectSocket({ code: 'internal' });

    const ip = ipBucket(request.headers.get('CF-Connecting-IP') || 'unknown');
    const ipHash = await keyedHash(env.IP_SECRET, ip);
    const directory = env.DIRECTORY.get(env.DIRECTORY.idFromName('main'));
    const call = async (path, body) => (await directory.fetch(`https://directory${path}`, { method: 'POST', body: JSON.stringify(body) })).json();

    const intent = url.searchParams.get('intent');
    let roomId;
    let code = '';
    if (intent === 'create') {
      const made = await call('/create', { ipHash, roomId: url.searchParams.get('room') || '' });
      if (made.error) return rejectSocket({ code: made.error, retryAfterS: made.retryAfterS });
      roomId = made.roomId;
      code = made.code;
    } else if (intent === 'join') {
      const found = await call('/lookup', { code: url.searchParams.get('code') || '', ipHash });
      if (found.error) return rejectSocket({ code: found.error, retryAfterS: found.retryAfterS });
      roomId = found.roomId;
    } else if (intent === 'member') {
      roomId = (url.searchParams.get('room') || '').replace(/[^0-9a-f]/g, '').slice(0, 64);
      if (!roomId) return rejectSocket({ code: 'invalid' });
    } else {
      return rejectSocket({ code: 'invalid' });
    }

    const roomIpHash = await keyedHash(env.IP_SECRET, `${ip}|${roomId}`);
    const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
    const headers = new Headers(request.headers);
    headers.set('x-room-id', roomId);
    headers.set('x-code', code);
    headers.set('x-ip-hash', roomIpHash);
    headers.set('x-intent', intent);
    return stub.fetch(new Request(request.url, { headers }));
  },
};

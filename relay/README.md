# Flowcus room relay

A Cloudflare Worker with two Durable Objects (SQLite-backed, WebSocket Hibernation) that lets a joiner find a study room from a 6-character code. It carries only the signed handshake blobs (an invite and a reply) between a joiner and a member. Timer and chat traffic never touch it: rooms stay peer-to-peer WebRTC.

| Piece | Job |
|---|---|
| `Directory` (one global) | code <-> room, per-IP rate limits |
| `Room` (one per room) | member sockets; routes a joiner's offer to the host, else a mod, else the earliest member; ban hashes; room lifetime |
| `src/core.js` | all the logic, no Cloudflare APIs, tested under `node:test` |

## Deploy (once)

```
cd relay
npm install
npx wrangler login
npx wrangler secret put IP_SECRET      # any long random string; used to hash addresses
npx wrangler deploy                     # prints https://flowcus-relay.<you>.workers.dev
curl https://flowcus-relay.<you>.workers.dev/v1/info
```

Then set `RELAY_URL` in `src/main/constants.js` to the same host with `wss://` and ship a release. With it empty, rooms still work and everyone joins through Advanced (manual invites).

## Operate

- `MIN_APP` (wrangler.toml `[vars]`): the lowest app version allowed to create or join. Raise it **only after** the matching release is live, or you lock users out before the update exists.
- `RELAY_DISABLED = "true"`: kill switch. Clients fall back to Advanced.
- Free tier: 100k Worker requests and 100k Durable Object requests per day. A join costs about 2 requests (one against each limit), so roughly 50k joins a day. Past that, joins fail until 00:00 UTC.
- Privacy: the relay sees the public IPs of people creating or joining and the signed SDP in flight. Addresses are stored only as keyed hashes, only for banned or recently joined people, and are deleted when the room ends. Nothing is logged.

## Develop without Cloudflare

```
node tools/local-relay.js 8787
FLOWCUS_RELAY_URL=ws://127.0.0.1:8787 npm start        # unpackaged runs only
npm run room:e2e                                       # starts its own local relay
```

Note: the Worker and Durable Object adapters (`src/index.js`, `directory.js`, `room.js`) have not been run on Cloudflare itself. The logic they wrap is tested; run `npx wrangler dev --local` and the end-to-end check against it once before the first release.

# Flowcus

A dark-mode focus timer for Windows, Linux and macOS, built on Electron. Two
timing modes (a fixed Pomodoro and a piecewise-tiered Flow mode), an optional
"Wall Method" pre-focus baseline, a local analytics dashboard, and peer-to-peer
study rooms that join with a short code. MIT licensed.

## Architecture

Strict segmentation by trust boundary:

- **`src/main/`** — the trusted side. Owns the clock (`timer-engine.js`),
  settings and session history (`store.js`), study-room identity and rules
  (`room-auth.js`, `room-service.js`, `room-timer.js`), the encrypted local
  key store (`secret-file.js`), the auto-updater (`update-manager.js`), and
  the anonymous stats reporter (`global-stats.js`).
- **`src/renderer/js/`** — draws state pushed from main and sends verbs back
  over a narrow `contextBridge` surface (`src/preload/preload.js`). It holds
  no timing truth and makes no network calls of its own — the page's CSP sets
  `connect-src 'none'`.
- **`src/renderer/js/room/`** — WebRTC plumbing only (`transport.js`,
  `room-controller.js`, `room-view.js`). It knows nothing about who is
  allowed in a room or what the timer says; it moves opaque signed strings
  between data channels and hands them to the main process.
- **`src/shared/room-protocol.js`** — the wire format and admission/host
  rules both sides validate against, isomorphic between main and renderer.

## Study rooms

Rooms are peer-to-peer over WebRTC data channels — full mesh, no TURN unless
the user supplies their own credentials. Capacity is capped at **12 peers**
(`MAX_PEERS` in `src/shared/room-protocol.js`).

**Joining by code.** The creator gets a 6-character code (`K7Q-X2M`, also a
`flowcus://join/K7QX2M` link and a QR code). A small signaling relay
(`relay/`, a free Cloudflare Worker, see `relay/README.md`) swaps the signed
handshake blobs between the joiner and a member; it never sees timer or chat
traffic, and the joiner's connection to it closes once the peer-to-peer
channel opens. All relay traffic runs in the main process
(`src/main/room-relay.js`, glued by `room-link.js`) because the renderer's CSP
forbids network access. A relay that is down, over quota or not configured
degrades to **Advanced**: the original copy-paste handshake, unchanged.

The handshake itself is signed end to end (`src/main/room-service.js`): the
joiner wraps an offer SDP as a signed invite, a member answers with a signed
reply bound to that joiner and that exact offer, and a channel opened this way
starts **quarantined** — it may carry nothing but a join request — until it is
admitted and moves to `active`. By default admission is instant (anyone with
the code may join); the host or a moderator can switch on "Ask me before
people join" for the old approve/decline dialog.

**Moderation.** The host and moderators they promote can kick, ban (by key in
the signed roster, plus a best-effort address block at the relay), mute chat,
rotate the code and toggle ask-first; only the host demotes moderators or ends
the room. Moderators can act only on plain members.

Identity is a per-room Ed25519 keypair generated with `node:crypto`
(`room-auth.js`); the private key never leaves that module and is persisted
only via the encrypted local store in `secret-file.js`. Every roster, host
claim and chat frame is signed and verified against this key.

Host handover survives a host disappearing: the first moderator takes over,
otherwise the earliest joiner (`electSuccessor` in `room-protocol.js`; the
roster keeps join order). When two sides disagree about who is host,
split-brain resolution (`compareHostClaims` / `acceptRoster`) orders competing
claims by **`(hostSeq, hostKey)`**: the higher sequence number wins outright; a
tie falls to the lower public key. A member cannot promote itself to host by
publishing a roster it wasn't given legitimate authority to sign.

Chat is ephemeral and in-memory only — it lives in the room's data-channel
traffic and process memory, never written to disk.

## Testing

189 tests, 0 failures, run with Node's built-in test runner:

```
npm test
```

Coverage includes the timer engine, the Flowcus tier algorithm, the room
protocol's admission and split-brain rules, room auth, room clock sync, and
the analytics rollup, moderation and succession, the relay core (against an
in-memory fake) and the QR encoder. A separate multi-instance, headless
end-to-end check (`npm run room:e2e`) drives two real Flowcus processes over
the Chrome DevTools Protocol, with a local relay (`tools/local-relay.js`),
through a full room lifecycle — join by code, timer sync, two-way chat, code
rotation, kick and rejoin, and host handover after the original host's window
closes.

## Auto-update

`src/main/update-manager.js` wraps `electron-updater` against this repo's
public GitHub Releases feed (configured in `electron-builder.yml`'s `publish`
key). It checks once on startup and every 4 hours after; when a build
finishes downloading it shows a native dialog with **Restart Now** /
**Later**. Because the repository and its releases are public, no distribution
token has to be embedded in the shipped binary.

## Anonymous global stats

`src/main/global-stats.js` is opt-out (default on, toggle in Settings →
Privacy → "Share anonymous study stats"). When a solo focus block ends, it
sends exactly:

```json
{ "anon_id": "<sha256 of a locally-generated Ed25519 public key>", "minutes_spent": 25 }
```

over Electron's `net` module — no name, no session content, nothing from a
study room. The renderer never talks to the endpoint directly (the page's CSP
forbids it); it asks main over IPC for the aggregate, which main fetches from
a whitelisted GET endpoint and displays as "Global Focus Hours" in the
titlebar. The endpoint and its API key are read from the environment
(`FLOWCUS_STATS_ENDPOINT` / `FLOWCUS_STATS_API_KEY`, see `.env.example`); with
neither set, reporting and fetching are both silent no-ops.

## Building

```
npm run build-win        # NSIS installer, ia32
npm run build-linux-deb  # .deb
npm run build-linux-rpm  # .rpm
npm run build-mac        # .dmg + .zip
```

Linux and macOS builds currently fall back to Electron's default icon —
`tools/make-icon.js` only generates the Windows `.ico`; a `.png`/`.icns` pass
still needs adding for those platforms to ship a proper icon.

## Microsoft Store

The same workflow also builds a Microsoft Store package (`.appx`, which the Store re-signs, so Windows never blocks it) from the same version. The Store build does not use `electron-updater`; the Store delivers its updates. Setup and submission steps: [docs/STORE.md](docs/STORE.md). Privacy policy: [PRIVACY.md](PRIVACY.md).

## License

MIT

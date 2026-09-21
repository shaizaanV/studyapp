'use strict';

const { createRoomAuth } = require('../../src/main/room-auth');
const { createInviteCodec } = require('../../src/main/room-invite');
const { RoomTimer } = require('../../src/main/room-timer');
const { RoomService } = require('../../src/main/room-service');

/** An in-memory stand-in for the encrypted key file. */
const memorySecret = () => {
  let cell = null;
  return { read: () => cell, write: (buffer) => { cell = Buffer.from(buffer); return true; } };
};

/**
 * A fake internet for RoomService: named nodes, a shared clock, and channels
 * that deliver instantly. It plays the renderer's part -- moving strings
 * between channels and completing relayed handshakes -- so a test can drive
 * real admission, relay, timer sync and host handover across several peers.
 */
function createWorld() {
  let now = 1_800_000_000_000;
  const clock = () => now;
  const nodes = new Map();
  const routes = new Map(); // "node:channelId" -> {node, id}
  const queue = [];
  let channelCounter = 0;

  function flush() {
    while (queue.length > 0) queue.shift()();
  }

  function addNode(name, { clockSkewMs = 0, settings = { focusMin: 25, breakMin: 5 } } = {}) {
    const nodeNow = () => now + clockSkewMs;
    const auth = createRoomAuth({ secret: memorySecret(), now: nodeNow });
    const invites = createInviteCodec({ auth, now: nodeNow });
    const timer = new RoomTimer({ now: nodeNow, getSettings: () => settings });
    const svc = new RoomService({ auth, invites, timer, now: nodeNow });
    const node = { name, auth, invites, timer, svc, key: auth.publicKey, events: [], alive: true };
    for (const event of ['session', 'focus-complete', 'alarm', 'alarm-stop']) {
      timer.on(event, (payload) => node.events.push({ name: event, payload }));
    }

    svc.on('send', ({ channelIds, data }) => {
      for (const id of channelIds) {
        const dest = routes.get(`${name}:${id}`);
        if (dest && dest.node.alive && node.alive) queue.push(() => dest.node.svc.handleData(dest.id, data));
      }
    });
    svc.on('close', ({ channelId }) => {
      const dest = routes.get(`${name}:${channelId}`);
      routes.delete(`${name}:${channelId}`);
      if (dest) {
        routes.delete(`${dest.node.name}:${dest.id}`);
        queue.push(() => dest.node.svc.channelClosed(dest.id));
      }
    });
    svc.on('relay-connect', ({ peerKey }) => {
      queue.push(() => svc.relayOut({ to: peerKey, kind: 'offer', sdp: `offer:${name}` }));
    });
    svc.on('relay-signal', ({ origin, kind }) => {
      const other = [...nodes.values()].find((n) => n.key === origin);
      if (kind === 'offer') {
        queue.push(() => svc.relayOut({ to: origin, kind: 'answer', sdp: `answer:${name}` }));
      } else if (other) {
        queue.push(() => link(node, other, 'relay', 'relay'));
      }
    });

    nodes.set(name, node);
    return node;
  }

  /** Opens a channel between two nodes; each side is told its own mode. */
  function link(a, b, modeA, modeB) {
    const idA = `c${channelCounter++}`;
    const idB = `c${channelCounter++}`;
    routes.set(`${a.name}:${idA}`, { node: b, id: idB });
    routes.set(`${b.name}:${idB}`, { node: a, id: idA });
    a.svc.channelOpen({ channelId: idA, mode: modeA, peerKey: b.key });
    b.svc.channelOpen({ channelId: idB, mode: modeB, peerKey: a.key });
    flush();
    return { idA, idB };
  }

  /** The full copy-paste dance: joiner's invite to `introducer`, reply back, channel opens. */
  function manualJoin(joiner, introducer, name = joiner.name) {
    const invite = joiner.svc.makeInvite(name, `sdp-offer:${joiner.name}`);
    const opened = introducer.svc.openInvite(invite.invite);
    if (!opened.ok) return { ok: false, error: opened.error };
    const reply = introducer.svc.makeReply(`sdp-answer:${introducer.name}`);
    const accepted = joiner.svc.openReply(reply.reply);
    if (!accepted.ok) return { ok: false, error: accepted.error };
    const ids = link(introducer, joiner, 'admit', 'joiner');
    return { ok: true, ...ids };
  }

  function advance(ms, step = 250) {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      now += step;
      for (const node of nodes.values()) {
        if (!node.alive) continue;
        node.svc.tick();
        node.timer.tick();
      }
      flush();
    }
  }

  /** Approve on the host and let the relay handshakes finish. */
  function admit(host, joiner) {
    const result = host.svc.approve(joiner.key);
    flush();
    advance(1000);
    return result;
  }

  /** Simulates a peer vanishing: its sends stop and nothing reaches it. */
  function kill(node) {
    node.alive = false;
  }

  return { addNode, link, manualJoin, advance, admit, kill, flush, nodes, get now() { return now; }, clock };
}

module.exports = { createWorld, memorySecret };

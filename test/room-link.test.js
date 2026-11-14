'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const P = require('../src/shared/room-protocol');
const { RelayClient } = require('../src/main/room-relay');
const { RoomLink } = require('../src/main/room-link');
const { createWorld } = require('./helpers/room-world');
const { createFakeRelay } = require('./helpers/fake-relay');

/** Lets queued socket messages flush, and member sockets that retry on a short real timer reconnect. */
const settle = async (rounds = 40) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 25));
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** A node with a relay client and link, plus a stand-in renderer that answers relayed invites. */
function wire(world, relay, name, { appVersion = '5.0.0' } = {}) {
  const node = world.addNode(name);
  node.relay = new RelayClient({
    url: 'wss://fake', appVersion, protocol: P.PROTOCOL_VERSION, auth: node.auth,
    WebSocketImpl: relay.WebSocket, fetchImpl: relay.fetch, setTimer: (ms, fn) => setTimeout(fn, 5),
  });
  node.phases = [];
  node.link = new RoomLink({
    service: node.svc,
    relay: node.relay,
    appVersion,
    onRenderer: (channel, payload) => {
      if (channel === 'join-phase') node.phases.push(payload.phase);
      if (channel !== 'relay-invite') return;
      const opened = node.svc.openInvite(payload.text);
      node.link.answerOffer({ joinId: payload.joinId, sdp: `sdp-answer:${name}`, to: opened.invite.pubKey, offerSdp: opened.invite.sdp });
    },
  });
  return node;
}

/** The renderer's half of a code join, then the data channel opens. */
async function codeJoin(world, joiner, code) {
  const started = await joiner.link.startJoin(code);
  if (!started.ok) return started;
  const sent = await joiner.link.submitOffer(joiner.name, `sdp-offer:${joiner.name}`);
  if (!sent.ok) return sent;
  const opened = joiner.svc.openReply(sent.reply);
  if (!opened.ok) return opened;
  const introducer = [...world.nodes.values()].find((n) => n.key === opened.reply.pubKey);
  world.link(introducer, joiner, 'admit', 'joiner');
  world.advance(1500);
  await settle();
  return { ok: true, introducer };
}

async function hostRoom() {
  const world = createWorld();
  const relay = createFakeRelay();
  const host = wire(world, relay, 'host');
  const created = await host.link.createRoom('Host');
  await settle();
  return { world, relay, host, created, code: host.relay.code };
}

test('creating a room registers it with the relay and shows a short code', async () => {
  const { host, code } = await hostRoom();
  assert.match(code, /^[A-Z2-9]{6}$/);
  const view = host.svc.view();
  assert.equal(view.relay.state, 'up');
  assert.equal(view.relay.code, `${code.slice(0, 3)}-${code.slice(3)}`);
  assert.equal(view.relay.link, `flowcus://join/${code}`);
});

test('typing the code joins the room with no copy-paste', async () => {
  const { world, relay, host, code } = await hostRoom();
  const joiner = wire(world, relay, 'joiner');
  const result = await codeJoin(world, joiner, code.toLowerCase());
  assert.ok(result.ok, result.error);
  assert.equal(joiner.svc.status, 'active');
  assert.equal(host.svc.view().members.length, 2);
  assert.deepEqual(joiner.phases, ['checking', 'waiting', 'connecting']);
  assert.equal(joiner.relay.member && !joiner.relay.member.closed, true, 'joiner took up relay presence');
  assert.equal(joiner.svc.view().relay.state, 'up');
});

test('a wrong code is refused, and repeated guessing is locked out', async () => {
  const { world, relay } = await hostRoom();
  const guesser = wire(world, relay, 'guesser');
  const first = await guesser.link.startJoin('AAAAAA');
  assert.equal(first.ok, false);
  assert.match(first.error, /isn't valid/);
  for (let i = 0; i < 8; i += 1) await guesser.link.startJoin('BBBBBB');
  const locked = await guesser.link.startJoin('CCCCCC');
  assert.match(locked.error, /Too many attempts/);
  relay.advance(11 * 60000);
  const later = await guesser.link.startJoin('CCCCCC');
  assert.match(later.error, /isn't valid/);
});

test('a malformed code never reaches the relay', async () => {
  const { world, relay } = await hostRoom();
  const joiner = wire(world, relay, 'joiner');
  assert.equal((await joiner.link.startJoin('nope')).ok, false);
});

test('rotating the code kills the old one and announces the new one to members', async () => {
  const { world, relay, host, code } = await hostRoom();
  const joiner = wire(world, relay, 'joiner');
  assert.ok((await codeJoin(world, joiner, code)).ok);
  host.relay.rotate();
  await settle();
  const fresh = host.relay.code;
  assert.notEqual(fresh, code);
  assert.equal(joiner.relay.code, fresh, 'every member learns the new code');
  assert.equal(joiner.svc.view().relay.code, `${fresh.slice(0, 3)}-${fresh.slice(3)}`);
  const late = wire(world, relay, 'late');
  assert.equal((await late.link.startJoin(code)).ok, false);
  assert.ok((await codeJoin(world, late, fresh)).ok);
});

test('moderators can rotate the code too; plain members cannot', async () => {
  const { world, relay, host, code } = await hostRoom();
  const mod = wire(world, relay, 'mod');
  const plain = wire(world, relay, 'plain');
  assert.ok((await codeJoin(world, mod, code)).ok);
  assert.ok((await codeJoin(world, plain, code)).ok);
  host.svc.moderate('promote', mod.key);
  world.advance(1500);
  await settle();

  plain.relay.rotate();
  await settle();
  assert.equal(host.relay.code, code, 'a plain member cannot rotate');
  mod.relay.rotate();
  await settle();
  assert.notEqual(host.relay.code, code);
});

test('a banned key is refused by the relay itself', async () => {
  const { world, relay, host, code } = await hostRoom();
  const troll = wire(world, relay, 'troll');
  assert.ok((await codeJoin(world, troll, code)).ok);
  assert.ok(host.svc.moderate('ban', troll.key).ok);
  world.advance(3000);
  await settle();
  assert.equal(troll.svc.view().notice.kind, 'banned');

  const again = await codeJoin(world, troll, code);
  assert.equal(again.ok, false);
  assert.match(again.error, /banned/);
});

test('a banned IP is refused even with a fresh identity', async () => {
  const { world, relay, host, code } = await hostRoom();
  relay.ip = '6.6.6.6';
  const troll = wire(world, relay, 'troll');
  assert.ok((await codeJoin(world, troll, code)).ok);
  host.svc.moderate('ban', troll.key);
  world.advance(3000);
  await settle();

  const reborn = wire(world, relay, 'reborn'); // new key, same address
  const result = await codeJoin(world, reborn, code);
  assert.equal(result.ok, false);
  assert.match(result.error, /banned/);
  relay.ip = '7.7.7.7';
  const elsewhere = wire(world, relay, 'elsewhere');
  assert.ok((await codeJoin(world, elsewhere, code)).ok, 'the IP block is per address, and best effort');
});

test('a kicked member loses relay presence', async () => {
  const { world, relay, host, code } = await hostRoom();
  const joiner = wire(world, relay, 'joiner');
  assert.ok((await codeJoin(world, joiner, code)).ok);
  host.svc.moderate('kick', joiner.key);
  world.advance(3000);
  await settle();
  assert.equal(joiner.svc.status, 'idle');
  assert.equal(joiner.relay.member, null);
});

test('an unsupported app version is told to update', async () => {
  const { world, relay, code } = await hostRoom();
  const old = wire(world, relay, 'old', { appVersion: '4.1.0' });
  const result = await old.link.startJoin(code);
  assert.equal(result.ok, false);
  assert.match(result.error, /not supported.*relaunch to update/i);
});

test('with the host offline, the relay routes the join to the next member', async () => {
  const { world, relay, host, code } = await hostRoom();
  const first = wire(world, relay, 'first');
  assert.ok((await codeJoin(world, first, code)).ok);
  host.relay.member.close(); // the host's relay socket drops; the host is still in the room
  await settle();

  const second = wire(world, relay, 'second');
  const result = await codeJoin(world, second, code);
  assert.ok(result.ok, result.error);
  assert.equal(result.introducer.key, first.key);
  assert.equal(second.svc.status, 'active');
  assert.equal(host.svc.view().members.length, 3);
});

test('the relay creating a room fails softly: the local room still works', async () => {
  const world = createWorld();
  const relay = createFakeRelay();
  relay.WebSocket = class { constructor() { throw new Error('offline'); } };
  const host = wire(world, relay, 'host');
  host.relay.WS = relay.WebSocket;
  const created = await host.link.createRoom('Host');
  assert.ok(created.ok);
  assert.ok(created.relayError);
  assert.equal(host.svc.view().relay.state, 'down');
  assert.equal(host.svc.view().status, 'active');
});

test('ending the room closes the code for everyone', async () => {
  const { world, relay, host, code } = await hostRoom();
  const joiner = wire(world, relay, 'joiner');
  assert.ok((await codeJoin(world, joiner, code)).ok);
  host.relay.end();
  host.svc.endRoom();
  await settle();
  assert.equal(relay.rooms.size, 0);
  const late = wire(world, relay, 'late');
  assert.equal((await late.link.startJoin(code)).ok, false);
});

test('a room whose members all leave closes after the grace period', async () => {
  const { world, relay, host, code } = await hostRoom();
  host.svc.leave();
  await settle();
  relay.advance(60000);
  const during = wire(world, relay, 'during');
  assert.equal((await during.link.startJoin(code)).ok, true, 'still open inside the grace period');
  during.link.closeSession();
  relay.advance(120000);
  await settle();
  const after = wire(world, relay, 'after');
  assert.equal((await after.link.startJoin(code)).ok, false);
});

test('the relay can hand a room off when the host changes', async () => {
  const { world, relay, host, code } = await hostRoom();
  const first = wire(world, relay, 'first');
  const second = wire(world, relay, 'second');
  assert.ok((await codeJoin(world, first, code)).ok);
  assert.ok((await codeJoin(world, second, code)).ok);
  world.kill(host);
  host.relay.member.close();
  world.advance(P.HOST_LOST_MS + 4000);
  await settle();
  assert.ok(first.svc.isHost);
  const late = wire(world, relay, 'late');
  const result = await codeJoin(world, late, code);
  assert.ok(result.ok, result.error);
});

test('checkVersion flags an app older than the relay minimum, and tolerates an unreachable relay', async () => {
  const { world, relay } = await hostRoom();
  const old = wire(world, relay, 'old', { appVersion: '4.1.0' });
  const result = await old.link.checkVersion();
  assert.equal(result.ok, false);
  assert.equal(result.unsupported, true);
  assert.match(result.error, /not supported.*relaunch to update/i);

  const current = wire(world, relay, 'current');
  assert.ok((await current.link.checkVersion()).ok);

  const offline = wire(world, relay, 'offline');
  offline.relay.fetch = async () => { throw new Error('offline'); };
  assert.ok((await offline.link.checkVersion()).ok);
});

test('the directory limits room creation per address and validates room ids', () => {
  const { DirectoryCore } = require('../relay/src/core');
  const dir = new DirectoryCore({ now: () => 1_800_000_000_000 });
  const id = (n) => n.toString(16).padStart(24, '0');
  assert.equal(dir.create('ip', 'not-an-id').error, 'invalid');
  assert.ok(dir.create('ip', id(1)).code);
  assert.equal(dir.create('ip', id(1)).error, 'invalid', 'a room id cannot be registered twice');
  assert.ok(dir.create('ip', id(2)).code);
  assert.ok(dir.create('ip', id(3)).code);
  assert.equal(dir.create('ip', id(4)).error, 'rate_limited', 'at most 3 live rooms per address');
  assert.ok(dir.create('other', id(5)).code, 'another address is unaffected');
});

test('codes are unique and a released room frees its code', () => {
  const { DirectoryCore } = require('../relay/src/core');
  const dir = new DirectoryCore();
  const id = (n) => n.toString(16).padStart(24, '0');
  const made = dir.create('a', id(1));
  assert.equal(dir.lookup(made.code, 'x').roomId, id(1));
  dir.release(id(1));
  assert.equal(dir.lookup(made.code, 'x').error, 'invalid');
  assert.equal(dir.lookup(made.code.toLowerCase(), 'x').error, 'invalid');
});

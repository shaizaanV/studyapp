'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const P = require('../src/shared/room-protocol');
const { createWorld } = require('./helpers/room-world');

const MIN = 60000;

/** A host with `count` admitted members, each introduced by the host. */
function room(count = 1, worldOptions) {
  const world = createWorld();
  const host = world.addNode('host', worldOptions);
  host.svc.createRoom('Host');
  const peers = [];
  for (let i = 1; i < count; i++) {
    const peer = world.addNode(`p${i}`);
    assert.ok(world.manualJoin(peer, host).ok);
    assert.ok(world.admit(host, peer).ok);
    peers.push(peer);
  }
  world.advance(2000);
  return { world, host, peers };
}

const lowestFirst = (nodes) => [...nodes].sort((a, b) => (a.key < b.key ? -1 : 1));

test('creating a room makes you the host of a one-person roster', () => {
  const world = createWorld();
  const host = world.addNode('host');
  const view = host.svc.createRoom('Hana');
  assert.equal(view.status, 'active');
  assert.equal(view.isHost, true);
  assert.equal(view.members.length, 1);
  assert.equal(view.members[0].name, 'Hana');
  assert.match(view.mnemonic, /^([A-Z]{4}-){2}[A-Z]{4}$/);
  assert.equal(host.timer.getState().room.role, 'host');
});

test('a joiner stays quarantined until the host approves, then becomes a follower', () => {
  const world = createWorld();
  const host = world.addNode('host');
  host.svc.createRoom('Host');
  const joiner = world.addNode('joiner');
  assert.ok(world.manualJoin(joiner, host).ok);

  const hostView = host.svc.view();
  assert.equal(hostView.members.length, 1);
  assert.equal(hostView.pending.length, 1);
  assert.equal(hostView.pending[0].name, 'joiner');
  assert.equal(hostView.pending[0].key, joiner.key);
  assert.match(hostView.pending[0].fingerprint, /^([A-Z]{4}-){5}[A-Z]{4}$/);
  assert.equal(joiner.svc.status, 'joining');

  world.admit(host, joiner);
  assert.equal(joiner.svc.status, 'active');
  assert.equal(joiner.svc.view().members.length, 2);
  assert.equal(host.svc.view().members.length, 2);
  assert.equal(host.svc.view().pending.length, 0);
  assert.equal(joiner.timer.getState().room.role, 'follower');
  assert.equal(joiner.svc.view().mnemonic, host.svc.view().mnemonic);
});

test('a quarantined channel cannot carry chat or timer traffic', () => {
  const world = createWorld();
  const host = world.addNode('host');
  host.svc.createRoom('Host');
  const joiner = world.addNode('joiner');
  const { idA } = world.manualJoin(joiner, host);

  const chat = joiner.auth.signFrame('chat', { text: 'let me in' });
  const timer = joiner.auth.signFrame('timer-action', { action: 'start' });
  const roster = joiner.auth.signFrame('roster', {
    roomId: host.svc.roster.roomId, rosterSeq: 99, hostSeq: 0, hostKey: joiner.key, members: [joiner.key],
  });
  for (const raw of [chat, timer, roster]) host.svc.handleData(idA, raw);

  assert.equal(host.svc.chat.length, 0);
  assert.equal(host.svc.roster.hostKey, host.key);
  assert.equal(host.svc.view().members.length, 1);
});

test('a join-request that names someone else, or another introducer, is ignored', () => {
  const world = createWorld();
  const host = world.addNode('host');
  host.svc.createRoom('Host');
  const joiner = world.addNode('joiner');
  const other = world.addNode('other');
  const { idA } = world.manualJoin(joiner, host);
  host.svc.pending.clear();

  host.svc.handleData(idA, joiner.auth.signFrame('join-request', { name: 'x', pubKey: other.key, introducer: host.key }));
  host.svc.handleData(idA, joiner.auth.signFrame('join-request', { name: 'x', pubKey: joiner.key, introducer: other.key }));
  assert.equal(host.svc.pending.size, 0);
});

test('unsigned, tampered and oversized frames are dropped', () => {
  const { host, peers, world } = room(2);
  const [peer] = peers;
  const channelId = [...host.svc.byKey.values()][0];
  const before = host.svc.chat.length;

  const good = JSON.parse(peer.auth.signFrame('chat', { text: 'hello' }));
  host.svc.handleData(channelId, JSON.stringify({ ...good, body: { text: 'tampered' } }));
  host.svc.handleData(channelId, 'not json');
  host.svc.handleData(channelId, 'x'.repeat(70000));
  host.svc.handleData(channelId, JSON.stringify({ ...good, sig: '' }));
  assert.equal(host.svc.chat.length, before);

  host.svc.handleData(channelId, JSON.stringify(good));
  assert.equal(host.svc.chat.length, before + 1);
  world.flush();
});

test('the host can decline: the joiner is told and the channel closes', () => {
  const world = createWorld();
  const host = world.addNode('host');
  host.svc.createRoom('Host');
  const joiner = world.addNode('joiner');
  world.manualJoin(joiner, host);

  assert.ok(host.svc.deny(joiner.key).ok);
  world.flush();
  assert.equal(joiner.svc.status, 'idle');
  assert.match(joiner.svc.error, /declined/);
  assert.equal(host.svc.view().pending.length, 0);
  world.advance(2000);
  assert.equal(host.svc.channels.size, 0, 'the denied channel is hung up');
});

test('an unanswered request times out after 60 seconds', () => {
  const world = createWorld();
  const host = world.addNode('host');
  host.svc.createRoom('Host');
  const joiner = world.addNode('joiner');
  world.manualJoin(joiner, host);
  world.advance(P.ADMISSION_TIMEOUT_MS - 1000);
  assert.equal(host.svc.view().pending.length, 1);
  world.advance(3000);
  assert.equal(host.svc.view().pending.length, 0);
  assert.equal(joiner.svc.status, 'idle');
});

test('a member introduces a newcomer; the host approves and the mesh completes', () => {
  const { world, host, peers } = room(2);
  const [b] = peers;
  const c = world.addNode('c');
  assert.ok(world.manualJoin(c, b).ok);

  // The request travels through the introducer to the host.
  world.flush();
  const pending = host.svc.view().pending;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].key, c.key);
  assert.equal(pending[0].introducerKey, b.key);
  assert.equal(pending[0].introducerName, 'p1');
  assert.equal(b.svc.view().pending[0].introducedByMe, true);

  world.admit(host, c);
  world.advance(3000);

  assert.equal(c.svc.status, 'active');
  assert.equal(c.svc.view().members.length, 3);
  // c reached both existing members directly: the introducer and, by relay, the host.
  assert.ok(c.svc.byKey.has(b.key));
  assert.ok(c.svc.byKey.has(host.key));
  assert.ok(host.svc.byKey.has(c.key));
  assert.ok(b.svc.byKey.has(c.key));
  assert.equal(b.svc.view().pending.length, 0);
});

test('relayed handshakes are forwarded verbatim through the introducer', () => {
  const { world, host, peers } = room(2);
  const [b] = peers;
  const c = world.addNode('c');
  world.manualJoin(c, b);
  world.admit(host, c);

  const forwarded = [];
  b.svc.on('send', ({ data }) => {
    const frame = JSON.parse(data);
    if (frame.type === 'signal-relay' && frame.from === c.key) forwarded.push(frame);
  });
  // Once the direct link exists relays are unnecessary, so drop it to force the detour.
  c.svc.closeChannel(c.svc.byKey.get(host.key));
  world.flush();
  c.svc.relayOut({ to: host.key, kind: 'offer', sdp: 'offer:again' });
  world.flush();
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].body.origin, c.key, 'still signed by the originator, not the relay');
  assert.ok(host.auth.verifyFrame(forwarded[0]).ok);
});

test('a room holds 12 people and refuses the 13th at the invite stage', () => {
  const { world, host } = room(12);
  assert.equal(host.svc.view().members.length, 12);
  const extra = world.addNode('extra');
  const invite = extra.svc.makeInvite('extra', 'sdp');
  const result = host.svc.openInvite(invite.invite);
  assert.equal(result.ok, false);
  assert.match(result.error, /full/);
});

test('timer changes reach every follower, even with a skewed clock', () => {
  const world = createWorld();
  const host = world.addNode('host');
  host.svc.createRoom('Host');
  const skewed = world.addNode('skewed', { clockSkewMs: 7000 });
  world.manualJoin(skewed, host);
  world.admit(host, skewed);
  world.advance(6000); // long enough for ping/pong to measure the offset

  host.timer.dispatch('start');
  world.flush();
  assert.equal(skewed.timer.getState().phase, 'FOCUS');

  world.advance(60_000);
  const hostLeft = host.timer.getState().focusRemainingMs;
  const skewedLeft = skewed.timer.getState().focusRemainingMs;
  assert.ok(Math.abs(hostLeft - skewedLeft) < 50, `host ${hostLeft} vs skewed ${skewedLeft}`);
  assert.ok(Math.abs(hostLeft - 24 * MIN) < 1500);
});

test('a joiner catches up to a session already in progress', () => {
  const world = createWorld();
  const host = world.addNode('host');
  host.svc.createRoom('Host');
  host.timer.dispatch('start');
  world.advance(5 * MIN);

  const late = world.addNode('late');
  world.manualJoin(late, host);
  world.admit(host, late);
  assert.equal(late.timer.getState().phase, 'FOCUS');
  assert.ok(Math.abs(late.timer.getState().focusRemainingMs - 20 * MIN) < 3000);
});

test('followers see the whole cycle: focus, break, alarm', () => {
  const { world, host, peers } = room(3);
  host.timer.dispatch('start');
  world.advance(25 * MIN + 1000);
  for (const peer of peers) assert.equal(peer.timer.getState().phase, 'BREAK');
  world.advance(5 * MIN);
  for (const peer of peers) {
    assert.equal(peer.timer.getState().phase, 'ALARM');
    assert.ok(peer.events.some((e) => e.name === 'session' && e.payload.room));
    assert.ok(peer.events.some((e) => e.name === 'alarm'));
  }
});

test('chat reaches everyone, attributed to the sender, in order', () => {
  const { world, host, peers } = room(3);
  assert.ok(host.svc.sendChat('hello room').ok);
  world.flush();
  assert.ok(peers[0].svc.sendChat('hi host').ok);
  world.flush();
  for (const node of [host, ...peers]) {
    const log = node.svc.view().chat;
    assert.deepEqual(log.map((m) => m.text), ['hello room', 'hi host']);
    assert.deepEqual(log.map((m) => m.name), ['Host', 'p1']);
  }
  assert.equal(host.svc.view().chat[0].self, true);
  assert.equal(peers[1].svc.view().chat[0].self, false);
});

test('chat is rate limited for the sender and again by each receiver', () => {
  const { world, host, peers } = room(2);
  const results = Array.from({ length: 8 }, (_, i) => peers[0].svc.sendChat(`m${i}`).ok);
  world.flush();
  assert.equal(results.filter(Boolean).length, 5);
  assert.equal(host.svc.view().chat.length, 5);

  // A modified client that ignores its own limit is still capped by the receiver.
  const channelId = [...host.svc.byKey.values()][0];
  world.advance(5000);
  host.svc.chat.length = 0;
  for (let i = 0; i < 20; i++) host.svc.handleData(channelId, peers[0].auth.signFrame('chat', { text: `flood${i}` }));
  assert.equal(host.svc.chat.length, 5);
});

test('oversized and empty chat is refused before sending', () => {
  const { host } = room(1);
  assert.equal(host.svc.sendChat('a'.repeat(2049)).ok, false);
  assert.equal(host.svc.sendChat('   ').ok, false);
  assert.equal(host.svc.sendChat('ok').ok, true);
});

test('a member cannot promote itself to host by publishing a roster', () => {
  const { world, host, peers } = room(3);
  const [b, c] = peers;
  const forged = b.auth.signFrame('roster', {
    ...host.svc.roster, rosterSeq: host.svc.roster.rosterSeq + 5, hostKey: b.key,
  });
  const channelId = [...c.svc.byKey.entries()].find(([key]) => key === b.key)[1];
  c.svc.handleData(channelId, forged);
  world.flush();
  assert.equal(c.svc.roster.hostKey, host.key);
  assert.equal(host.svc.roster.hostKey, host.key);
});

test('a stale or replayed roster is ignored', () => {
  const { world, host, peers } = room(3);
  const c = peers[1];
  const staleRoster = { ...host.svc.roster, rosterSeq: 1, members: [host.key] };
  const channelId = c.svc.byKey.get(host.key);
  c.svc.handleData(channelId, host.auth.signFrame('roster', staleRoster));
  world.flush();
  assert.equal(c.svc.roster.members.length, 3);
});

test('when the host goes silent for 8 seconds, the lowest remaining key takes over', () => {
  const { world, host, peers } = room(4);
  const expected = lowestFirst(peers)[0];
  host.timer.dispatch('start');
  world.advance(2000);
  const endsAt = host.timer.snapshot().endsAtEpochMs;

  world.kill(host);
  world.advance(P.HOST_LOST_MS - 2000);
  for (const peer of peers) assert.equal(peer.svc.isHost, false, 'not yet');
  world.advance(4000);

  const hosts = peers.filter((p) => p.svc.isHost);
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].key, expected.key);
  assert.equal(expected.svc.roster.hostSeq, 1);
  for (const peer of peers) {
    assert.equal(peer.svc.roster.hostKey, expected.key);
    assert.equal(peer.svc.roster.hostSeq, 1);
    assert.ok(!peer.svc.roster.members.includes(host.key), 'the silent host is dropped');
  }
  assert.equal(expected.timer.snapshot().endsAtEpochMs, endsAt, 'the running phase carries over');
  assert.equal(expected.timer.getState().room.role, 'host');
  for (const peer of peers.filter((p) => p !== expected)) {
    assert.equal(peer.timer.getState().phase, 'FOCUS');
    assert.equal(peer.timer.getState().room.role, 'follower');
  }

  // The new host now drives the room.
  expected.timer.dispatch('pause');
  world.flush();
  for (const peer of peers) assert.equal(peer.timer.getState().phase, 'FOCUS_PAUSED');
});

test('a host that says goodbye is replaced without waiting out the silence', () => {
  const { world, host, peers } = room(3);
  host.svc.leave();
  world.flush();
  world.advance(1000);
  assert.equal(peers.filter((p) => p.svc.isHost).length, 1);
});

test('a joiner that has not linked to the host yet never mistakes silence for a dead host', () => {
  const { world, host, peers } = room(2);
  const [b] = peers;
  const c = world.addNode('c');
  world.manualJoin(c, b);
  world.admit(host, c);
  // Drop the relayed link to the host, so c only has its introducer.
  c.svc.closeChannel(c.svc.byKey.get(host.key));
  c.svc.hostLinked = false;
  c.svc.hostHeardAt = 0;
  world.advance(20_000);
  assert.equal(c.svc.isHost, false);
});

test('a returning old host cannot overwrite the new host state', () => {
  const { world, host, peers } = room(3);
  const expected = lowestFirst(peers)[0];
  world.kill(host);
  world.advance(12_000);
  assert.ok(expected.svc.isHost);

  const staleState = host.auth.signFrame('timer-state', {
    phase: 'FOCUS', endsAtEpochMs: world.now + 999 * MIN, remainingMs: null,
    focusMs: 25 * MIN, breakMs: 5 * MIN, hostSeq: 0, seq: 500,
  });
  const other = peers.find((p) => p !== expected);
  const channelId = other.svc.byKey.get(expected.key);
  other.svc.handleData(channelId, staleState);
  assert.equal(other.timer.getState().phase, 'IDLE');
});

test('a member who leaves is removed from the roster by the host', () => {
  const { world, host, peers } = room(3);
  peers[0].svc.leave();
  world.flush();
  assert.equal(host.svc.roster.members.length, 2);
  assert.ok(!host.svc.roster.members.includes(peers[0].key));
  assert.equal(peers[1].svc.roster.members.length, 2);
  assert.equal(peers[0].svc.status, 'idle');
});

test('a member who goes silent is pruned by the host', () => {
  const { world, host, peers } = room(3);
  world.kill(peers[0]);
  world.advance(P.HOST_LOST_MS + 2000);
  assert.ok(!host.svc.roster.members.includes(peers[0].key));
  assert.ok(peers[1].svc.roster.members.length === 2);
});

test('leaving hands the timer back and clears the room', () => {
  const { host } = room(1);
  let left = 0;
  host.svc.on('left', () => left++);
  host.svc.leave();
  assert.equal(left, 1);
  assert.equal(host.svc.view().status, 'idle');
  assert.equal(host.svc.view().members.length, 0);
});

test('an invite you made yourself, or for a room you are already in, is refused', () => {
  const { world, host, peers } = room(2);
  const own = host.svc.makeInvite; // host is active, so it cannot make one
  assert.equal(own.call(host.svc, 'x', 'sdp').ok, false);

  const dup = world.addNode('dup');
  const invite = peers[0].svc.invites.encode({ kind: 'invite', roomId: '', name: 'p1', sdp: 'sdp' });
  assert.match(host.svc.openInvite(invite).error, /already in this room/);
  assert.ok(dup);
});

test('a reply from a different room, or with no room, is not accepted', () => {
  const world = createWorld();
  const host = world.addNode('host');
  const joiner = world.addNode('joiner');
  joiner.svc.makeInvite('joiner', 'sdp');
  const noRoom = host.invites.encode({ kind: 'reply', roomId: '', name: 'Host', sdp: 'sdp' });
  assert.equal(joiner.svc.openReply(noRoom).ok, false);
});

test('a joiner refuses a roster for a different room than the one it was invited to', () => {
  const world = createWorld();
  const host = world.addNode('host');
  host.svc.createRoom('Host');
  const impostor = world.addNode('impostor');
  impostor.svc.createRoom('Impostor');
  const joiner = world.addNode('joiner');
  const { idB } = world.manualJoin(joiner, host);

  const wrongRoster = impostor.auth.signFrame('roster', {
    ...impostor.svc.roster, members: [impostor.key, joiner.key],
  });
  joiner.svc.handleData(idB, wrongRoster);
  assert.equal(joiner.svc.status, 'joining');
});

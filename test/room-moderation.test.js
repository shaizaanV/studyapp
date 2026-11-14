'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const P = require('../src/shared/room-protocol');
const { createWorld } = require('./helpers/room-world');

/** Open-join room: the host plus `count - 1` peers, each admitted with no approval step. */
function room(count = 3) {
  const world = createWorld();
  const host = world.addNode('host');
  host.svc.createRoom('Host');
  const peers = [];
  for (let i = 1; i < count; i++) {
    const peer = world.addNode(`p${i}`);
    assert.ok(world.manualJoin(peer, host).ok);
    world.advance(1500);
    peers.push(peer);
  }
  world.advance(2000);
  return { world, host, peers };
}

const memberKeys = (node) => node.svc.view().members.map((m) => m.key);

test('open join admits a newcomer instantly, with no pending request', () => {
  const { host, peers } = room(2);
  assert.equal(peers[0].svc.status, 'active');
  assert.equal(host.svc.view().pending.length, 0);
  assert.equal(host.svc.view().members.length, 2);
  assert.equal(host.svc.view().admission, 'open');
});

test('ask-first mode keeps the approval modal; open mode skips it', () => {
  const world = createWorld();
  const host = world.addNode('host');
  host.svc.createRoom('Host');
  assert.ok(host.svc.moderate('policy', undefined, 'ask').ok);
  const joiner = world.addNode('joiner');
  assert.ok(world.manualJoin(joiner, host).ok);
  assert.equal(host.svc.view().pending.length, 1);
  assert.equal(joiner.svc.status, 'joining');

  assert.ok(host.svc.moderate('policy', undefined, 'open').ok);
  const second = world.addNode('second');
  assert.ok(world.manualJoin(second, host).ok);
  world.advance(1500);
  assert.equal(second.svc.status, 'active');
});

test('a member introduced through a non-host is admitted instantly too', () => {
  const { world, host, peers } = room(2);
  const late = world.addNode('late');
  assert.ok(world.manualJoin(late, peers[0]).ok);
  world.advance(2500);
  assert.equal(late.svc.status, 'active');
  assert.equal(host.svc.view().members.length, 3);
});

test('kick removes the member, tells them why, and lets them rejoin', () => {
  const { world, host, peers } = room(3);
  const [a, b] = peers;
  assert.ok(host.svc.moderate('kick', a.key).ok);
  world.advance(3000);
  assert.equal(a.svc.status, 'idle');
  assert.equal(a.svc.view().notice.kind, 'kicked');
  assert.ok(!memberKeys(host).includes(a.key));
  assert.ok(!memberKeys(b).includes(a.key));
  assert.ok(world.manualJoin(a, host).ok, 'a kick is not a ban');
  world.advance(2000);
  assert.equal(a.svc.status, 'active');
});

test('ban removes the member and refuses their invite, directly and through others', () => {
  const { world, host, peers } = room(3);
  const [a, b] = peers;
  assert.ok(host.svc.moderate('ban', a.key).ok);
  world.advance(3000);
  assert.equal(a.svc.view().notice.kind, 'banned');
  assert.ok(host.svc.roster.banned.includes(a.key));
  assert.ok(b.svc.roster.banned.includes(a.key));

  const direct = world.manualJoin(a, host);
  assert.equal(direct.ok, false);
  assert.match(direct.error, /banned/);
  const viaMember = world.manualJoin(a, b);
  assert.equal(viaMember.ok, false);
  assert.match(viaMember.error, /banned/);
});

test('a banned key that slips past a stale introducer is still denied by the host', () => {
  const { world, host, peers } = room(2);
  const outsider = world.addNode('outsider');
  // Make the host ban a key that is not in the room, then have it try via a member.
  host.svc.pending.set(outsider.key, { key: outsider.key, name: 'o', introducer: host.key, channelId: null, at: world.now });
  assert.ok(host.svc.moderate('ban', outsider.key).ok);
  world.advance(1500);
  assert.ok(peers[0].svc.roster.banned.includes(outsider.key));
  const result = world.manualJoin(outsider, peers[0]);
  assert.equal(result.ok, false);
});

test('moderators can kick and mute members but not the host, other mods, or themselves', () => {
  const { world, host, peers } = room(5);
  const [m1, m2, victim, other] = peers;
  assert.ok(host.svc.moderate('promote', m1.key).ok);
  assert.ok(host.svc.moderate('promote', m2.key).ok);
  world.advance(1500);
  assert.equal(m1.svc.selfRole, 'mod');

  assert.equal(m1.svc.moderate('kick', host.key).ok, true, 'request is sent');
  world.advance(1000);
  assert.ok(memberKeys(host).includes(host.key), 'host cannot be kicked');
  m1.svc.moderate('kick', m2.key);
  world.advance(1000);
  assert.ok(memberKeys(host).includes(m2.key), 'a mod cannot kick another mod');

  assert.ok(m1.svc.moderate('mute', victim.key).ok);
  world.advance(1500);
  assert.ok(host.svc.roster.muted.includes(victim.key));
  assert.ok(m1.svc.moderate('kick', other.key).ok);
  world.advance(3000);
  assert.ok(!memberKeys(host).includes(other.key));
});

test('plain members cannot moderate', () => {
  const { world, host, peers } = room(3);
  const [a, b] = peers;
  assert.equal(a.svc.moderate('kick', b.key).ok, false);
  const forged = a.svc.sign('mod-action', { action: 'kick', target: b.key });
  host.svc.handleData(host.svc.byKey.get(a.key), forged);
  world.advance(1500);
  assert.ok(memberKeys(host).includes(b.key));
});

test('only the host can demote a moderator or end the room', () => {
  const { world, host, peers } = room(3);
  const [a, b] = peers;
  host.svc.moderate('promote', a.key);
  host.svc.moderate('promote', b.key);
  world.advance(1500);
  a.svc.moderate('demote', b.key);
  world.advance(1500);
  assert.ok(host.svc.roster.mods.includes(b.key));
  assert.equal(a.svc.endRoom().ok, false);
  assert.ok(host.svc.moderate('demote', b.key).ok);
  assert.ok(!host.svc.roster.mods.includes(b.key));
});

test('mods can switch admission mode', () => {
  const { world, host, peers } = room(2);
  host.svc.moderate('promote', peers[0].key);
  world.advance(1500);
  assert.ok(peers[0].svc.moderate('policy', undefined, 'ask').ok);
  world.advance(1000);
  assert.equal(host.svc.view().admission, 'ask');
});

test('muted members cannot chat and nobody shows their messages', () => {
  const { world, host, peers } = room(3);
  const [a, b] = peers;
  assert.ok(host.svc.moderate('mute', a.key).ok);
  world.advance(1500);
  assert.equal(a.svc.sendChat('hello?').ok, false);
  // A tampered client that ignores its own mute is dropped by every receiver.
  a.svc.chatLimiter = { allow: () => true };
  const raw = a.svc.sign('chat', { text: 'spam' });
  b.svc.handleData(b.svc.byKey.get(a.key), raw);
  host.svc.handleData(host.svc.byKey.get(a.key), raw);
  assert.equal(b.svc.view().chat.length, 0);
  assert.equal(host.svc.view().chat.length, 0);

  assert.ok(host.svc.moderate('unmute', a.key).ok);
  world.advance(1500);
  assert.ok(a.svc.sendChat('back').ok);
  world.advance(500);
  assert.equal(b.svc.view().chat.length, 1);
});

test('ending the room sends everyone out with a notice', () => {
  const { world, host, peers } = room(3);
  assert.ok(host.svc.endRoom().ok);
  world.advance(2000);
  assert.equal(host.svc.status, 'idle');
  for (const peer of peers) {
    assert.equal(peer.svc.status, 'idle');
    assert.equal(peer.svc.view().notice.kind, 'ended');
  }
});

test('when the host disappears, the first moderator takes over', () => {
  const { world, host, peers } = room(4);
  const [first, second, third] = peers;
  host.svc.moderate('promote', third.key);
  world.advance(1500);
  world.kill(host);
  world.advance(P.HOST_LOST_MS + 4000);
  assert.ok(third.svc.isHost, 'the moderator beats the earlier joiners');
  assert.equal(first.svc.isHost, false);
  assert.equal(second.svc.isHost, false);
  assert.equal(first.svc.roster.hostKey, third.key);
  assert.ok(!first.svc.roster.mods.includes(third.key), 'the new host is no longer listed as a mod');
});

test('with no moderator, the earliest joiner takes over and join order is kept', () => {
  const { world, host, peers } = room(4);
  world.kill(host);
  world.advance(P.HOST_LOST_MS + 4000);
  assert.ok(peers[0].svc.isHost);
  assert.deepEqual(memberKeys(peers[1]), [peers[0].key, peers[1].key, peers[2].key]);
});

test('bans, mutes and the admission mode survive a host handover', () => {
  const { world, host, peers } = room(4);
  const [a, b, c] = peers;
  host.svc.moderate('ban', c.key);
  host.svc.moderate('mute', b.key);
  host.svc.moderate('policy', undefined, 'ask');
  world.advance(3000);
  world.kill(host);
  world.advance(P.HOST_LOST_MS + 4000);
  assert.ok(a.svc.isHost);
  assert.ok(a.svc.roster.banned.includes(c.key));
  assert.ok(a.svc.roster.muted.includes(b.key));
  assert.equal(a.svc.roster.admission, 'ask');
});

test('a reply made for one joiner is refused by another', () => {
  const world = createWorld();
  const host = world.addNode('host');
  host.svc.createRoom('Host');
  const one = world.addNode('one');
  const two = world.addNode('two');
  const inviteOne = one.svc.makeInvite('one', 'sdp-offer:one');
  two.svc.makeInvite('two', 'sdp-offer:two');
  assert.ok(host.svc.openInvite(inviteOne.invite).ok);
  const reply = host.svc.makeReply('sdp-answer', { to: one.key, offerSdp: 'sdp-offer:one' });
  assert.equal(two.svc.openReply(reply.reply).ok, false);
  assert.ok(one.svc.openReply(reply.reply).ok);
});

test('a reply for the right joiner but a different offer is refused', () => {
  const world = createWorld();
  const host = world.addNode('host');
  host.svc.createRoom('Host');
  const joiner = world.addNode('joiner');
  joiner.svc.makeInvite('joiner', 'sdp-offer:joiner');
  const reply = host.svc.makeReply('sdp-answer', { to: joiner.key, offerSdp: 'some other offer' });
  assert.equal(joiner.svc.openReply(reply.reply).ok, false);
});

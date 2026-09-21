'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRoomAuth } = require('../src/main/room-auth');
const { createInviteCodec } = require('../src/main/room-invite');
const P = require('../src/shared/room-protocol');
const { memorySecret } = require('./helpers/room-world');

const fresh = (now = () => 1_000) => createRoomAuth({ secret: memorySecret(), now });

test('a key is created once and reused from the secret store', () => {
  const secret = memorySecret();
  const first = createRoomAuth({ secret });
  const second = createRoomAuth({ secret });
  assert.equal(first.publicKey, second.publicKey);
  assert.equal(Buffer.from(first.publicKey, 'base64url').length, 32);
});

test('a corrupt stored key is replaced instead of crashing', () => {
  const secret = memorySecret();
  secret.write(Buffer.from('not a key'));
  const auth = createRoomAuth({ secret });
  assert.equal(Buffer.from(auth.publicKey, 'base64url').length, 32);
});

test('signatures verify for the signer and for nobody else', () => {
  const a = fresh();
  const b = fresh();
  const sig = a.sign('hello');
  assert.ok(b.verify(a.publicKey, sig, 'hello'));
  assert.ok(!b.verify(a.publicKey, sig, 'hellO'));
  assert.ok(!b.verify(b.publicKey, sig, 'hello'));
  assert.ok(!b.verify('garbage', sig, 'hello'));
  assert.ok(!b.verify(a.publicKey, 'garbage', 'hello'));
});

test('signed frames verify, and any tampering breaks them', () => {
  const a = fresh();
  const b = fresh();
  const frame = JSON.parse(a.signFrame('chat', { text: 'hi' }));
  assert.ok(b.verifyFrame(frame).ok);

  assert.ok(!b.verifyFrame({ ...frame, body: { text: 'hi!' } }).ok);
  assert.ok(!b.verifyFrame({ ...frame, from: b.publicKey }).ok);
  assert.ok(!b.verifyFrame({ ...frame, seq: frame.seq + 1 }).ok);
  assert.ok(!b.verifyFrame({ ...frame, type: 'heartbeat' }).ok);
});

test('frame sequence numbers increase', () => {
  const a = fresh();
  const first = JSON.parse(a.signFrame('heartbeat', { hostSeq: 0 }));
  const second = JSON.parse(a.signFrame('heartbeat', { hostSeq: 0 }));
  assert.ok(second.seq > first.seq);
});

test('fingerprints are six stable words and differ per key', () => {
  const a = fresh();
  const b = fresh();
  const fp = a.fingerprint(a.publicKey);
  assert.equal(fp, a.fingerprint(a.publicKey));
  assert.match(fp, /^([A-Z]{4}-){5}[A-Z]{4}$/);
  assert.notEqual(fp, a.fingerprint(b.publicKey));
});

test('the room mnemonic is three stable words derived from the room id', () => {
  const a = fresh();
  assert.match(a.mnemonic('room-1'), /^([A-Z]{4}-){2}[A-Z]{4}$/);
  assert.equal(a.mnemonic('room-1'), a.mnemonic('room-1'));
  assert.notEqual(a.mnemonic('room-1'), a.mnemonic('room-2'));
});

test('fingerprint words come from a 2048-word space', () => {
  const a = fresh();
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    for (const word of a.mnemonic(`r${i}`).split('-')) seen.add(word);
  }
  assert.ok(seen.size > 250, 'words vary widely');
});

// -------------------------------------------------------------------- invites

const pair = (now = () => 5_000) => {
  const alice = fresh(now);
  const bob = fresh(now);
  return { alice, bob, aliceCodec: createInviteCodec({ auth: alice, now }), bobCodec: createInviteCodec({ auth: bob, now }) };
};

const sdp = 'v=0\r\na=fingerprint:sha-256 AA:BB\r\n';

test('an invite round-trips and carries the sender identity', () => {
  const { alice, aliceCodec, bobCodec } = pair();
  const blob = aliceCodec.encode({ kind: 'invite', roomId: '', name: 'Alice', sdp });
  assert.ok(blob.startsWith('ROOM_'));
  const result = bobCodec.decode(blob, 'invite');
  assert.ok(result.ok);
  assert.equal(result.invite.pubKey, alice.publicKey);
  assert.equal(result.invite.name, 'Alice');
  assert.equal(result.invite.sdp, sdp);
});

test('a blob is refused for the wrong kind', () => {
  const { aliceCodec, bobCodec } = pair();
  const blob = aliceCodec.encode({ kind: 'reply', roomId: 'r', name: 'Alice', sdp });
  assert.ok(!bobCodec.decode(blob, 'invite').ok);
  assert.ok(bobCodec.decode(blob, 'reply').ok);
});

test('swapping the SDP in a blob invalidates it', () => {
  const zlib = require('node:zlib');
  const { aliceCodec, bobCodec } = pair();
  const blob = aliceCodec.encode({ kind: 'invite', roomId: '', name: 'Alice', sdp });
  const inner = JSON.parse(zlib.inflateRawSync(Buffer.from(blob.slice(5), 'base64url')).toString());
  inner.sdp = sdp.replace('AA:BB', 'EV:IL');
  const forged = 'ROOM_' + zlib.deflateRawSync(Buffer.from(JSON.stringify(inner))).toString('base64url');
  const result = bobCodec.decode(forged, 'invite');
  assert.ok(!result.ok);
  assert.match(result.error, /signature/);
});

test('a substituted key with the original signature is refused', () => {
  const zlib = require('node:zlib');
  const { bob, aliceCodec, bobCodec } = pair();
  const blob = aliceCodec.encode({ kind: 'invite', roomId: '', name: 'Alice', sdp });
  const inner = JSON.parse(zlib.inflateRawSync(Buffer.from(blob.slice(5), 'base64url')).toString());
  inner.pubKey = bob.publicKey;
  const forged = 'ROOM_' + zlib.deflateRawSync(Buffer.from(JSON.stringify(inner))).toString('base64url');
  assert.ok(!bobCodec.decode(forged, 'invite').ok);
});

test('an invite expires after ten minutes', () => {
  let t = 1000;
  const { aliceCodec, bobCodec } = pair(() => t);
  const blob = aliceCodec.encode({ kind: 'invite', roomId: '', name: 'Alice', sdp });
  t += P.INVITE_TTL_MS - 1;
  assert.ok(bobCodec.decode(blob, 'invite').ok);
  t += 2;
  const late = bobCodec.decode(blob, 'invite');
  assert.ok(!late.ok);
  assert.match(late.error, /expired/);
});

test('garbage never throws', () => {
  const { bobCodec } = pair();
  for (const input of ['', 'hello', 'ROOM_', 'ROOM_!!!', 'ROOM_' + 'A'.repeat(100), null, undefined, 'ROOM_' + 'A'.repeat(40000)]) {
    assert.ok(!bobCodec.decode(input, 'invite').ok);
  }
});

test('a decompression bomb is refused', () => {
  const zlib = require('node:zlib');
  const { bobCodec } = pair();
  const bomb = 'ROOM_' + zlib.deflateRawSync(Buffer.alloc(5_000_000, 0x20)).toString('base64url');
  assert.ok(!bobCodec.decode(bomb, 'invite').ok);
});

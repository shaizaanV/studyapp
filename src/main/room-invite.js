'use strict';

const zlib = require('node:zlib');

const P = require('../shared/room-protocol');

const PREFIX = 'ROOM_';
const MAX_BLOB_CHARS = 32 * 1024;
const MAX_INFLATED_BYTES = 64 * 1024;
const MAX_SDP_CHARS = 16 * 1024;
const KINDS = ['invite', 'reply'];

/**
 * The copy-paste blobs that carry a WebRTC handshake between two people:
 * ROOM_ + base64url(deflate(JSON{v, kind, roomId, pubKey, name, sdp, exp, sig})).
 *
 * `sig` covers every other field, so the SDP (and the DTLS fingerprint inside
 * it) is bound to the sender's identity key. Someone who alters the blob in
 * transit invalidates it; they cannot substitute their own SDP and keep the
 * key. An invite comes from the joiner and has no room yet (roomId ''); a
 * reply comes from the admitting member and carries the room id.
 */
function createInviteCodec({ auth, now = Date.now }) {
  function encode({ kind, roomId, name, sdp }) {
    const signed = auth.signObject({
      v: P.PROTOCOL_VERSION,
      kind,
      roomId: roomId || '',
      pubKey: auth.publicKey,
      name,
      sdp,
      exp: now() + P.INVITE_TTL_MS,
    });
    return PREFIX + zlib.deflateRawSync(Buffer.from(JSON.stringify(signed))).toString('base64url');
  }

  /** Returns {ok:true, invite} or {ok:false, error}. Never throws on bad input. */
  function decode(text, expectedKind) {
    const blob = String(text || '').trim();
    if (!blob.startsWith(PREFIX)) return { ok: false, error: 'That is not a room invite.' };
    if (blob.length > MAX_BLOB_CHARS) return { ok: false, error: 'That invite is too large.' };

    let invite;
    try {
      const inflated = zlib.inflateRawSync(Buffer.from(blob.slice(PREFIX.length), 'base64url'), {
        maxOutputLength: MAX_INFLATED_BYTES,
      });
      invite = JSON.parse(inflated.toString('utf8'));
    } catch {
      return { ok: false, error: 'That invite is damaged. Copy it again.' };
    }

    const wellFormed =
      invite && typeof invite === 'object' &&
      invite.v === P.PROTOCOL_VERSION &&
      KINDS.includes(invite.kind) &&
      typeof invite.roomId === 'string' && invite.roomId.length <= 64 &&
      typeof invite.pubKey === 'string' && invite.pubKey.length > 0 && invite.pubKey.length <= 256 &&
      typeof invite.name === 'string' && invite.name.length > 0 && invite.name.length <= P.MAX_NAME_LENGTH &&
      typeof invite.sdp === 'string' && invite.sdp.length > 0 && invite.sdp.length <= MAX_SDP_CHARS &&
      Number.isFinite(invite.exp);
    if (!wellFormed) return { ok: false, error: 'That invite is damaged. Copy it again.' };

    if (invite.kind !== expectedKind) {
      return { ok: false, error: expectedKind === 'invite' ? 'That is a reply, not an invite.' : 'That is an invite, not a reply.' };
    }
    if (!auth.verifyObject(invite, invite.pubKey)) return { ok: false, error: 'That invite failed its signature check.' };
    if (invite.exp < now()) return { ok: false, error: 'That invite has expired. Ask for a new one.' };
    return { ok: true, invite };
  }

  return { encode, decode };
}

module.exports = { createInviteCodec, PREFIX };

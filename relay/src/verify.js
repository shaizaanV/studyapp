'use strict';

/**
 * Signature and invite checks for the relay, on WebCrypto and
 * DecompressionStream only, so the same file runs in a Cloudflare Worker and
 * under Node's test runner.
 */
const P = require('../../src/shared/room-protocol');

const b64uToBytes = (text) => {
  const padded = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

const keyCache = new Map();

async function importKey(pubKey) {
  if (keyCache.has(pubKey)) return keyCache.get(pubKey);
  let key = null;
  try {
    const raw = b64uToBytes(pubKey);
    if (raw.length === 32) {
      try {
        key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
      } catch {
        key = await crypto.subtle.importKey('raw', raw, { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' }, false, ['verify']);
      }
    }
  } catch {
    key = null;
  }
  if (keyCache.size > 512) keyCache.clear();
  keyCache.set(pubKey, key);
  return key;
}

async function verifyText(pubKey, signature, text) {
  const key = await importKey(pubKey);
  if (!key) return false;
  try {
    const algorithm = key.algorithm.name === 'NODE-ED25519' ? { name: 'NODE-ED25519' } : { name: 'Ed25519' };
    return await crypto.subtle.verify(algorithm, key, b64uToBytes(signature), new TextEncoder().encode(text));
  } catch {
    return false;
  }
}

/** Shape and signature check of a wire frame (a JSON string or parsed object). */
async function verifyFrame(input) {
  let frame = input;
  if (typeof input === 'string') {
    try {
      frame = JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (!P.validateFrame(frame).ok) return null;
  const { sig, ...unsigned } = frame;
  return (await verifyText(frame.from, sig, P.canonicalJson(unsigned))) ? frame : null;
}

/** A signed plain object ({...fields, sig}) checked against `pubKey`. */
async function verifyObject(object, pubKey) {
  if (!object || typeof object !== 'object' || typeof object.sig !== 'string') return false;
  const { sig, ...fields } = object;
  return verifyText(pubKey, sig, P.canonicalJson(fields));
}

const MAX_BLOB_CHARS = 32 * 1024;
const MAX_INFLATED_BYTES = 64 * 1024;
const MAX_SDP_CHARS = 16 * 1024;

/**
 * Opens a ROOM_ invite blob and verifies its signature, version and expiry.
 * Returns the decoded invite, or {error} naming why it was refused.
 */
async function openInvite(blob, now) {
  const text = String(blob || '').trim();
  if (!text.startsWith('ROOM_') || text.length > MAX_BLOB_CHARS) return { error: 'malformed' };
  let invite;
  try {
    const stream = new Blob([b64uToBytes(text.slice(5))]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    if (bytes.length > MAX_INFLATED_BYTES) return { error: 'malformed' };
    invite = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { error: 'malformed' };
  }
  if (!invite || typeof invite !== 'object') return { error: 'malformed' };
  if (invite.v !== P.PROTOCOL_VERSION) return { error: 'unsupported' };
  const wellFormed =
    invite.kind === 'invite' &&
    typeof invite.pubKey === 'string' && invite.pubKey.length > 0 && invite.pubKey.length <= 256 &&
    typeof invite.name === 'string' && invite.name.length > 0 && invite.name.length <= P.MAX_NAME_LENGTH &&
    typeof invite.sdp === 'string' && invite.sdp.length > 0 && invite.sdp.length <= MAX_SDP_CHARS &&
    Number.isFinite(invite.exp);
  if (!wellFormed) return { error: 'malformed' };
  if (invite.exp < now) return { error: 'expired' };
  if (!(await verifyObject(invite, invite.pubKey))) return { error: 'badsig' };
  return { invite };
}

/** Dotted-number compare: negative when a < b. Missing parts count as 0. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

module.exports = { verifyFrame, verifyObject, openInvite, compareVersions, b64uToBytes };

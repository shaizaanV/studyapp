'use strict';

const crypto = require('node:crypto');

const P = require('../shared/room-protocol');

/** DER prefix that turns a raw 32-byte Ed25519 public key into an SPKI key. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const RAW_KEY_BYTES = 32;

const b64u = (buffer) => Buffer.from(buffer).toString('base64url');

/**
 * 2048 pronounceable four-letter words (consonant, vowel, consonant, vowel).
 * Eleven bits each, so six of them carry ~66 bits of a key fingerprint. They
 * are read aloud and compared by eye; they are not meant to look like a
 * dictionary.
 */
const CONSONANTS = 'bdfghjklmnprstvz';
const VOWELS = 'aeio';
const wordAt = (index) =>
  CONSONANTS[index & 15] + VOWELS[(index >> 4) & 3] + CONSONANTS[(index >> 6) & 15] + 'ao'[(index >> 10) & 1];

/** Reads `count` 11-bit groups from the start of `bytes` as words. */
function wordsFrom(bytes, count) {
  const words = [];
  let bits = 0;
  let acc = 0;
  let cursor = 0;
  while (words.length < count) {
    acc = (acc << 8) | bytes[cursor++];
    bits += 8;
    if (bits >= 11) {
      bits -= 11;
      words.push(wordAt((acc >> bits) & 0x7ff));
      acc &= (1 << bits) - 1;
    }
  }
  return words;
}

const sha256 = (input) => crypto.createHash('sha256').update(input).digest();

/**
 * Identity and signatures for one installation.
 *
 * The Ed25519 private key never leaves this module. `secret` is where it is
 * persisted: {read(): Buffer|null, write(Buffer)}. In production that wraps
 * safeStorage; in tests it is a plain in-memory cell. A `secret` that cannot
 * persist still works, the identity is just fresh each launch.
 */
function createRoomAuth({ secret, now = Date.now }) {
  let privateKey = null;
  const stored = secret.read();
  if (stored) {
    try {
      privateKey = crypto.createPrivateKey({ key: stored, format: 'der', type: 'pkcs8' });
    } catch {
      privateKey = null; // corrupt or from another machine: start a new identity
    }
  }
  if (!privateKey) {
    privateKey = crypto.generateKeyPairSync('ed25519').privateKey;
    secret.write(privateKey.export({ format: 'der', type: 'pkcs8' }));
  }

  const rawPublic = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-RAW_KEY_BYTES);
  const publicKey = b64u(rawPublic);

  const publicKeyCache = new Map();
  function importPublic(pubKey) {
    if (publicKeyCache.has(pubKey)) return publicKeyCache.get(pubKey);
    const raw = Buffer.from(String(pubKey), 'base64url');
    if (raw.length !== RAW_KEY_BYTES) return null;
    let key = null;
    try {
      key = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
    } catch {
      key = null;
    }
    if (publicKeyCache.size > 256) publicKeyCache.clear();
    publicKeyCache.set(pubKey, key);
    return key;
  }

  const sign = (data) => b64u(crypto.sign(null, Buffer.from(data), privateKey));

  function verify(pubKey, signature, data) {
    const key = importPublic(pubKey);
    if (!key) return false;
    try {
      return crypto.verify(null, Buffer.from(data), key, Buffer.from(String(signature), 'base64url'));
    } catch {
      return false;
    }
  }

  let seq = 0;

  /** Builds and signs a frame envelope; returns the wire string. */
  function signFrame(type, body) {
    const unsigned = { v: P.PROTOCOL_VERSION, type, from: publicKey, seq: seq++, ts: now(), body };
    return JSON.stringify({ ...unsigned, sig: sign(P.canonicalJson(unsigned)) });
  }

  /** Shape and signature check of a parsed frame. */
  function verifyFrame(frame) {
    const shape = P.validateFrame(frame);
    if (!shape.ok) return shape;
    const { sig, ...unsigned } = frame;
    return verify(frame.from, sig, P.canonicalJson(unsigned)) ? { ok: true } : { ok: false, error: 'frame: bad signature' };
  }

  /** Signs an arbitrary object under `sig`, over the canonical JSON of its other fields. */
  const signObject = (fields) => ({ ...fields, sig: sign(P.canonicalJson(fields)) });

  function verifyObject(object, pubKey) {
    if (!object || typeof object !== 'object') return false;
    const { sig, ...fields } = object;
    return typeof sig === 'string' && verify(pubKey, sig, P.canonicalJson(fields));
  }

  /** Six words (~66 bits) that identify a public key when compared out of band. */
  const fingerprint = (pubKey) => wordsFrom(sha256(Buffer.from(String(pubKey), 'base64url')), 6).join('-').toUpperCase();

  /** A non-secret three-word label derived from a room id. */
  const mnemonic = (roomId) => wordsFrom(sha256(String(roomId)), 3).join('-').toUpperCase();

  return { publicKey, sign, verify, signFrame, verifyFrame, signObject, verifyObject, fingerprint, mnemonic };
}

module.exports = { createRoomAuth };

'use strict';

/**
 * Short room codes: 6 characters from a 32-symbol alphabet with no look-alikes
 * (no 0/O, 1/I), shown as `K7Q-X2M`. Pure and dependency-free so main, the
 * relay worker and the renderer can all load it. Randomness is injected.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RoomCode = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const CODE_LENGTH = 6;
  const LINK_PREFIX = 'flowcus://join/';

  /** @param {(n: number) => Uint8Array} randomBytes */
  function generate(randomBytes) {
    const bytes = randomBytes(CODE_LENGTH);
    let out = '';
    for (let i = 0; i < CODE_LENGTH; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
    return out;
  }

  /** Uppercases and strips spaces/dashes. Returns '' for anything that is not a valid code. */
  function normalize(text) {
    const cleaned = String(text || '').toUpperCase().replace(/[\s-]/g, '');
    return isValid(cleaned) ? cleaned : '';
  }

  function isValid(code) {
    if (typeof code !== 'string' || code.length !== CODE_LENGTH) return false;
    for (const ch of code) if (!ALPHABET.includes(ch)) return false;
    return true;
  }

  const format = (code) => `${code.slice(0, 3)}-${code.slice(3)}`;
  const buildLink = (code) => `${LINK_PREFIX}${code}`;

  /** Extracts the code from a flowcus://join/CODE link, or '' if it is not one. */
  function parseLink(text) {
    const value = String(text || '').trim();
    if (!value.toLowerCase().startsWith(LINK_PREFIX)) return '';
    return normalize(value.slice(LINK_PREFIX.length).replace(/[/?#].*$/, ''));
  }

  return { ALPHABET, CODE_LENGTH, generate, normalize, isValid, format, buildLink, parseLink };
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const C = require('../src/shared/room-code');

test('the alphabet has 32 unique symbols and no look-alikes', () => {
  assert.equal(C.ALPHABET.length, 32);
  assert.equal(new Set(C.ALPHABET).size, 32);
  for (const bad of ['0', 'O', '1', 'I']) assert.ok(!C.ALPHABET.includes(bad), bad);
});

test('generate makes 6 valid characters and is spread over the alphabet', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const code = C.generate((n) => crypto.randomBytes(n));
    assert.equal(code.length, 6);
    assert.ok(C.isValid(code));
    for (const ch of code) seen.add(ch);
  }
  assert.equal(seen.size, 32);
});

test('normalize accepts any casing, spaces and dashes, and rejects the rest', () => {
  assert.equal(C.normalize('k7q-x2m'), 'K7QX2M');
  assert.equal(C.normalize(' K7Q X2M '), 'K7QX2M');
  assert.equal(C.normalize('K7QX2'), '');
  assert.equal(C.normalize('K7QX2MM'), '');
  assert.equal(C.normalize('K7QX2O'), '', 'O is not in the alphabet');
  assert.equal(C.normalize(null), '');
});

test('format and links round trip', () => {
  assert.equal(C.format('K7QX2M'), 'K7Q-X2M');
  assert.equal(C.buildLink('K7QX2M'), 'flowcus://join/K7QX2M');
  assert.equal(C.parseLink('flowcus://join/K7QX2M'), 'K7QX2M');
  assert.equal(C.parseLink('FLOWCUS://join/k7q-x2m/'), 'K7QX2M');
  assert.equal(C.parseLink('flowcus://join/K7QX2M?x=1'), 'K7QX2M');
  assert.equal(C.parseLink('https://join/K7QX2M'), '');
  assert.equal(C.parseLink('flowcus://join/NOPE'), '');
});

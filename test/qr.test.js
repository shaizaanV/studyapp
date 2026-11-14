'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const QR = require('../src/shared/qr');

const at = (qr, x, y) => qr.modules[y][x];

test('a join link round trips through encode and decode', () => {
  for (const text of ['flowcus://join/K7QX2M', 'a', 'hello world', 'x'.repeat(14), 'y'.repeat(26), 'z'.repeat(42), 'w'.repeat(62), 'v'.repeat(84), 'u'.repeat(106), 'ünïcode ✓']) {
    const decoded = QR.decode(QR.encode(text));
    assert.equal(decoded.text, text);
  }
});

test('the symbol grows with the text and is version 2 for a join link', () => {
  const link = QR.encode('flowcus://join/K7QX2M');
  assert.equal(link.size, 25);
  assert.equal(QR.decode(link).version, 2);
  assert.equal(QR.encode('a').size, 21);
  assert.equal(QR.encode('u'.repeat(106)).size, 41);
  assert.throws(() => QR.encode('u'.repeat(107)), /too long/);
});

test('finder patterns, separators, timing and the dark module are where the spec puts them', () => {
  const qr = QR.encode('flowcus://join/K7QX2M');
  const n = qr.size;
  const finder = (ox, oy) => {
    for (let dy = 0; dy < 7; dy += 1) {
      for (let dx = 0; dx < 7; dx += 1) {
        const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        assert.equal(at(qr, ox + dx, oy + dy), ring !== 2, `finder at ${ox},${oy} cell ${dx},${dy}`);
      }
    }
  };
  finder(0, 0);
  finder(n - 7, 0);
  finder(0, n - 7);
  for (let i = 8; i < n - 8; i += 1) {
    assert.equal(at(qr, i, 6), i % 2 === 0, `timing row ${i}`);
    assert.equal(at(qr, 6, i), i % 2 === 0, `timing column ${i}`);
  }
  assert.equal(at(qr, 8, n - 8), true, 'dark module');
  // version 2 has one alignment pattern, centred at (18, 18)
  assert.equal(at(qr, 18, 18), true);
  assert.equal(at(qr, 17, 18), false);
  assert.equal(at(qr, 16, 18), true);
});

test('both copies of the format information agree', () => {
  const qr = QR.encode('flowcus://join/K7QX2M');
  const n = qr.size;
  const first = [];
  for (let i = 0; i <= 5; i += 1) first.push(at(qr, 8, i));
  first.push(at(qr, 8, 7), at(qr, 8, 8), at(qr, 7, 8));
  for (let i = 9; i < 15; i += 1) first.push(at(qr, 14 - i, 8));
  const second = [];
  for (let i = 0; i < 8; i += 1) second.push(at(qr, n - 1 - i, 8));
  for (let i = 8; i < 15; i += 1) second.push(at(qr, 8, n - 15 + i));
  assert.deepEqual(first, second);
});

test('encoding is deterministic and different links give different symbols', () => {
  const a = JSON.stringify(QR.encode('flowcus://join/K7QX2M').modules);
  assert.equal(a, JSON.stringify(QR.encode('flowcus://join/K7QX2M').modules));
  assert.notEqual(a, JSON.stringify(QR.encode('flowcus://join/K7QX2N').modules));
});

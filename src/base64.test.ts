import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bytesToBase64 } from './base64';

test('empty input encodes to an empty string', () => {
  assert.equal(bytesToBase64(new Uint8Array([])), '');
});

test('pads a single remaining byte', () => {
  assert.equal(bytesToBase64(new Uint8Array([0x4d])), 'TQ==');
});

test('pads two remaining bytes', () => {
  assert.equal(bytesToBase64(new Uint8Array([0x4d, 0x61])), 'TWE=');
});

test('encodes exactly three bytes with no padding', () => {
  assert.equal(bytesToBase64(new Uint8Array([0x4d, 0x61, 0x6e])), 'TWFu');
});

test('matches Node Buffer for arbitrary binary data', () => {
  const bytes = Uint8Array.from({ length: 512 }, (_, i) => (i * 37 + 11) % 256);
  assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
});

test('round-trips real ESC/POS bytes', () => {
  // ESC @ then ESC t 2, what every job starts with.
  const job = new Uint8Array([0x1b, 0x40, 0x1b, 0x74, 0x02, 0xff, 0x00, 0xa4]);
  const decoded = Buffer.from(bytesToBase64(job), 'base64');
  assert.deepEqual(Array.from(decoded), Array.from(job));
});

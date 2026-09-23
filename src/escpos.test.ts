import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CODEPAGE, EscPosBuilder, encodeAscii, encodeCodepage850, twoColumns, wrap } from './escpos';

test('a job starts with init then an explicit codepage', () => {
  const bytes = Array.from(new EscPosBuilder().init().codepage(CODEPAGE.CP850).build());
  assert.deepEqual(bytes, [0x1b, 0x40, 0x1b, 0x74, 0x02]);
});

test('size packs width and height multipliers into one byte', () => {
  const bytes = Array.from(new EscPosBuilder().size(2, 2).build());
  assert.deepEqual(bytes, [0x1d, 0x21, 0x11]);
});

test('line appends a line feed after the text', () => {
  const bytes = Array.from(new EscPosBuilder().line('Hi').build());
  assert.deepEqual(bytes, [0x48, 0x69, 0x0a]);
});

test('feedToTear feeds enough lines to clear the tear bar', () => {
  const bytes = Array.from(new EscPosBuilder().feedToTear().build());
  assert.deepEqual(bytes, [0x1b, 0x64, 18]);
});

test('CP850 encodes Spanish accents, ASCII fallback strips them', () => {
  const cp = encodeCodepage850('Línea Núñez');
  assert.ok(cp.includes(0xa4), 'ñ should map to 0xa4 in CP850');
  const ascii = encodeAscii('Línea Núñez');
  assert.ok(!ascii.some((b) => b > 0x7f), 'ascii fallback must stay 7-bit');
});

test('twoColumns right-aligns the value within the paper width', () => {
  const row = twoColumns('Importe', '$85.00', 32);
  assert.equal(row.length, 32);
  assert.ok(row.endsWith('$85.00'));
});

test('a raster emits the GS v 0 header followed by the bitmap', () => {
  const bytes = Array.from(new EscPosBuilder().raster({ widthDots: 8, heightDots: 2, data: [0xff, 0x00] }).build());
  assert.deepEqual(bytes, [0x1d, 0x76, 0x30, 0x00, 1, 0, 2, 0, 0xff, 0x00]);
});

test('an empty raster emits no bytes rather than a broken command', () => {
  const b = new EscPosBuilder();
  b.raster({ widthDots: 0, heightDots: 0, data: [] });
  assert.equal(b.length, 0);
});

test('wrap breaks at spaces and keeps every line within the width', () => {
  const rows = wrap('Keep your ticket for travel insurance purposes', { columns: 20 });
  assert.deepEqual(rows, ['Keep your ticket for', 'travel insurance', 'purposes']);
});

test('wrap cuts a word only when it is longer than a whole line', () => {
  assert.deepEqual(wrap('ABCDEFGHIJ xy', { columns: 4 }), ['ABCD', 'EFGH', 'IJ', 'xy']);
});

test('wrap indents continuation lines under the first', () => {
  assert.deepEqual(wrap('Terminal Sur Mexico City', { columns: 16, indent: '->  ' }), [
    '->  Terminal Sur',
    '    Mexico City',
  ]);
});

test('wrap keeps explicit line breaks and empty text', () => {
  assert.deepEqual(wrap('a\nb'), ['a', 'b']);
  assert.deepEqual(wrap(''), ['']);
});

test('wrapped prints one line feed per wrapped row', () => {
  const bytes = Array.from(new EscPosBuilder().wrapped('aa bb', { columns: 2 }).build());
  assert.deepEqual(bytes, [0x61, 0x61, 0x0a, 0x62, 0x62, 0x0a]);
});

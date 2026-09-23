import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EscPosBuilder } from './escpos';
import { previewReceipt } from './preview';

const rows = (b: EscPosBuilder, columns = 10) => previewReceipt(b.build(), { columns, frame: false }).split('\n');

test('applies alignment per line', () => {
  const b = new EscPosBuilder().init().line('ab').align('center').line('ab').align('right').line('ab');
  assert.deepEqual(rows(b), ['ab        ', '    ab    ', '        ab']);
});

test('double width spreads characters and double height adds a row', () => {
  const b = new EscPosBuilder().init().size(2, 2).line('ab').size(1, 1).line('c');
  assert.deepEqual(rows(b), ['a b       ', '          ', 'c         ']);
});

test('decodes code page 850 back to accented text', () => {
  assert.deepEqual(rows(new EscPosBuilder().init().line('Ñandú'), 5), ['Ñandú']);
});

test('long feeds collapse into one row', () => {
  const b = new EscPosBuilder().init().line('x').feed(18);
  assert.deepEqual(rows(b, 22), ['x'.padEnd(22), '  [ 18 blank lines ]  ']);
});

test('lines longer than the paper wrap like the printer does', () => {
  assert.deepEqual(rows(new EscPosBuilder().init().line('abcdefghijkl')), ['abcdefghij', 'kl        ']);
});

test('images are drawn as ASCII art', () => {
  // A 16 x 16 solid square on 16-dot wide paper at 2 columns: fully black.
  const image = { widthDots: 16, heightDots: 16, data: new Array(32).fill(0xff) };
  const text = previewReceipt(new EscPosBuilder().init().raster(image).build(), { columns: 2, widthDots: 16, frame: false });
  assert.deepEqual(text.split('\n'), ['##']);
});

test('draws a frame by default', () => {
  assert.equal(previewReceipt(new EscPosBuilder().line('hi').build(), { columns: 4 }), '+----+\n|hi  |\n+----+');
});

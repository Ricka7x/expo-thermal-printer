import { test } from 'node:test';
import assert from 'node:assert/strict';

import { previewReceipt } from 'expo-thermal-printer/escpos';

import { samples } from './samples';

/**
 * The example templates are documentation, and documentation that doesn't run
 * rots. These check each one builds, fits its paper, and says what it should.
 */

for (const sample of samples) {
  test(`${sample.name} fits ${sample.columns} columns`, () => {
    const preview = previewReceipt(sample.build(), { columns: sample.columns, frame: false });
    for (const row of preview.split('\n')) {
      assert.ok(row.length <= sample.columns, `row too wide: ${JSON.stringify(row)}`);
    }
  });
}

const preview = (name: string) => {
  const sample = samples.find((s) => s.name === name)!;
  return previewReceipt(sample.build(), { columns: sample.columns, frame: false });
};

test('retail receipt totals include tax and change', () => {
  const text = preview('retail-receipt');
  // 89.50 + 36.00 + 43.80 = 169.30; tax 16% = 27.09; total 196.39; change from 250 = 53.61.
  assert.match(text, /Subtotal\s+\$169\.30/);
  assert.match(text, /Tax 16%\s+\$27\.09/);
  assert.match(text, /T O T A L\s+\$ 1 9 6 \. 3 9/);
  assert.match(text, /Change\s+\$53\.61/);
  assert.match(text, /Café de olla/);
});

test('kitchen order indents modifiers under their item', () => {
  const text = preview('kitchen-order');
  assert.match(text, /2x Tacos al pastor\s+- No onion/);
  assert.match(text, /T A B L E {3}1 2/);
});

test('shift report flags a cash difference', () => {
  // Expected 1000 + 6420.50 - 89.50 = 7331.00; counted 7321.00.
  const text = preview('shift-report');
  assert.match(text, /Expected in drawer\s+\$7,331\.00/);
  assert.match(text, /\*\* DIFFERENCE \*\*\s+-\$10\.00/);
});

test('80mm bill lines up the item table and tips', () => {
  const text = preview('restaurant-bill-80mm');
  assert.match(text, /^3   Enchiladas suizas\s+\$435\.00$/m);
  assert.match(text, /15%  tip \$106\.80\s+total \$818\.80/);
});

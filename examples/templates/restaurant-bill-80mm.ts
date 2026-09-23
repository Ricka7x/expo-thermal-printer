import { CODEPAGE, EscPosBuilder, fitColumns, twoColumns } from '@ricka7x/expo-thermal-printer/escpos';

import { money } from '../format';

/**
 * A restaurant bill for 80mm paper (48 columns, 576 dots). Shows how every
 * helper takes a column count, a three-column item table, and a suggested
 * tip table.
 */

export const COLUMNS_80MM = 48;

export type RestaurantBill = {
  restaurant: string;
  table: string;
  guests: number;
  items: { quantity: number; name: string; price: number }[];
  tipRates: number[];
};

export function buildRestaurantBill(bill: RestaurantBill): Uint8Array {
  const columns = COLUMNS_80MM;
  const b = new EscPosBuilder().init().codepage(CODEPAGE.CP850);

  b.align('center').bold(true).size(2, 2).line(bill.restaurant).size(1, 1).bold(false);
  b.line(`Table ${bill.table} - ${bill.guests} guests`);
  b.dashedRule(columns);

  // Three columns: quantity (4), name (fills), amount (10).
  b.align('left');
  b.bold(true).line(fitColumns('Qty', 4) + fitColumns('Item', columns - 14) + fitColumns('Amount', 10, 'right')).bold(false);
  let subtotal = 0;
  for (const item of bill.items) {
    const amount = item.quantity * item.price;
    subtotal += amount;
    b.line(fitColumns(String(item.quantity), 4) + fitColumns(item.name, columns - 14) + fitColumns(money(amount), 10, 'right'));
  }
  b.dashedRule(columns);
  b.bold(true).line(twoColumns('Total', money(subtotal), columns)).bold(false);

  b.feed(1).align('center').line('Suggested tip').align('left');
  for (const rate of bill.tipRates) {
    const tip = Math.round(subtotal * rate * 100) / 100;
    b.line(twoColumns(`${Math.round(rate * 100)}%  tip ${money(tip)}`, `total ${money(subtotal + tip)}`, columns));
  }
  b.feed(1).align('center').line('Thank you!');
  return b.feedToTear().build();
}

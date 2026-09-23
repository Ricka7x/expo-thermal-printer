import { CODEPAGE, EscPosBuilder, twoColumns } from '@ricka7x/expo-thermal-printer/escpos';

import { dateTime } from '../format';

/**
 * A kitchen order ticket: read from a distance, so the table and quantities
 * are big. Shows mixing sizes on one ticket and indented modifiers.
 */

export type KitchenOrder = {
  table: string;
  orderNumber: number;
  server: string;
  date: Date;
  items: { quantity: number; name: string; modifiers?: string[] }[];
  note?: string;
};

export function buildKitchenOrder(order: KitchenOrder): Uint8Array {
  const b = new EscPosBuilder().init().codepage(CODEPAGE.CP850);

  b.align('center').bold(true).size(2, 2).line(`TABLE ${order.table}`).size(1, 1).bold(false);
  b.line(`Order #${order.orderNumber}`);
  b.align('left').line(twoColumns(order.server, dateTime(order.date)));
  b.tearLine('=');

  for (const item of order.items) {
    // Double height only: taller, so it reads from the pass, but still 32 columns wide.
    b.bold(true).size(1, 2).wrapped(`${item.quantity}x ${item.name}`).size(1, 1).bold(false);
    for (const modifier of item.modifiers ?? []) {
      b.wrapped(modifier, { indent: '   - ' });
    }
    b.feed(1);
  }

  if (order.note) {
    b.tearLine('=');
    b.bold(true).line('NOTE').bold(false);
    b.wrapped(order.note);
  }
  return b.feedToTear().build();
}

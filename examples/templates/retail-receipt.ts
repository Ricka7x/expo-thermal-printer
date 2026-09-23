import { CODEPAGE, EscPosBuilder, fitColumns, twoColumns } from '@ricka7x/expo-thermal-printer/escpos';

import { dateTime, money } from '../format';
import { ringLogo } from '../logo';

/**
 * A shop receipt: logo, header, items with quantity and unit price, tax,
 * payment and change. Shows images, three-column item rows, and double size
 * for the total.
 */

export type RetailSale = {
  shop: { name: string; address: string; phone: string };
  receiptNumber: string;
  date: Date;
  cashier: string;
  items: { name: string; quantity: number; unitPrice: number }[];
  taxRate: number;
  paid: { method: string; amount: number };
  footer: string;
};

export function buildRetailReceipt(sale: RetailSale): Uint8Array {
  const b = new EscPosBuilder().init().codepage(CODEPAGE.CP850);

  b.align('center').raster(ringLogo()).feed(1);
  b.bold(true).line(sale.shop.name).bold(false);
  b.wrapped(sale.shop.address);
  b.line(sale.shop.phone);
  b.dashedRule();

  b.align('left');
  b.line(twoColumns(`Receipt ${sale.receiptNumber}`, dateTime(sale.date)));
  b.line(`Cashier: ${sale.cashier}`);
  b.dashedRule();

  let subtotal = 0;
  for (const item of sale.items) {
    const lineTotal = item.quantity * item.unitPrice;
    subtotal += lineTotal;
    // Name on its own line, then "qty x price" and the line total, so long
    // names never push the numbers out of place.
    b.line(fitColumns(item.name, 32));
    b.line(twoColumns(`  ${item.quantity} x ${money(item.unitPrice)}`, money(lineTotal)));
  }

  const tax = Math.round(subtotal * sale.taxRate * 100) / 100;
  const total = subtotal + tax;
  b.dashedRule();
  b.line(twoColumns('Subtotal', money(subtotal)));
  b.line(twoColumns(`Tax ${Math.round(sale.taxRate * 100)}%`, money(tax)));
  // Double width halves the columns: 16 characters for the whole row.
  b.bold(true).size(2, 2).line(twoColumns('TOTAL', money(total), 16)).size(1, 1).bold(false);
  b.feed(1);
  b.line(twoColumns(sale.paid.method, money(sale.paid.amount)));
  b.line(twoColumns('Change', money(sale.paid.amount - total)));

  b.feed(1).align('center').wrapped(sale.footer);
  return b.feedToTear().build();
}

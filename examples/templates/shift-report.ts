import { CODEPAGE, EscPosBuilder, twoColumns } from '@ricka7x/expo-thermal-printer/escpos';

import { dateTime, money } from '../format';

/**
 * An end-of-shift cash report: totals by payment method, expected against
 * counted cash, and a signature line. Shows a report made of label/value
 * rows and how to flag a problem (a cash difference).
 */

export type ShiftReport = {
  register: string;
  cashier: string;
  openedAt: Date;
  closedAt: Date;
  salesCount: number;
  byMethod: { method: string; amount: number }[];
  refunds: number;
  openingCash: number;
  countedCash: number;
};

export function buildShiftReport(report: ShiftReport): Uint8Array {
  const b = new EscPosBuilder().init().codepage(CODEPAGE.CP850);

  b.align('center').bold(true).size(1, 2).line('SHIFT REPORT').size(1, 1).bold(false);
  b.line(report.register);
  b.dashedRule();

  b.align('left');
  b.line(twoColumns('Cashier', report.cashier));
  b.line(twoColumns('Opened', dateTime(report.openedAt)));
  b.line(twoColumns('Closed', dateTime(report.closedAt)));
  b.line(twoColumns('Sales', String(report.salesCount)));
  b.dashedRule();

  let totalSales = 0;
  for (const entry of report.byMethod) {
    totalSales += entry.amount;
    b.line(twoColumns(entry.method, money(entry.amount)));
  }
  b.line(twoColumns('Refunds', money(-report.refunds)));
  b.bold(true).line(twoColumns('Net sales', money(totalSales - report.refunds))).bold(false);
  b.dashedRule();

  const cashSales = report.byMethod.find((entry) => entry.method === 'Cash')?.amount ?? 0;
  const expected = report.openingCash + cashSales - report.refunds;
  const difference = report.countedCash - expected;
  b.line(twoColumns('Opening cash', money(report.openingCash)));
  b.line(twoColumns('Expected in drawer', money(expected)));
  b.line(twoColumns('Counted', money(report.countedCash)));
  b.bold(true).line(twoColumns(difference === 0 ? 'Difference' : '** DIFFERENCE **', money(difference))).bold(false);

  b.feed(3);
  b.line('_'.repeat(32));
  b.align('center').line('Cashier signature');
  return b.feedToTear().build();
}

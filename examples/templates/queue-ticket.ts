import { CODEPAGE, EscPosBuilder } from '@ricka7x/expo-thermal-printer/escpos';

import { dateTime } from '../format';

/**
 * A take-a-number ticket: one huge number and little else. Shows the largest
 * character size and a centred layout.
 */

export type QueueTicket = {
  place: string;
  service: string;
  number: string;
  ahead: number;
  date: Date;
};

export function buildQueueTicket(ticket: QueueTicket): Uint8Array {
  const b = new EscPosBuilder().init().codepage(CODEPAGE.CP850).align('center');

  b.bold(true).line(ticket.place).bold(false);
  b.line(ticket.service);
  b.feed(1);
  // Four times as wide: 8 columns, enough for a number like "A-042" (5).
  b.bold(true).size(4, 4).line(ticket.number).size(1, 1).bold(false);
  b.feed(1);
  b.line(ticket.ahead === 1 ? '1 person ahead of you' : `${ticket.ahead} people ahead of you`);
  b.line(dateTime(ticket.date));
  return b.feedToTear().build();
}

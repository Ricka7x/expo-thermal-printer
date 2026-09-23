import { buildKitchenOrder } from './templates/kitchen-order';
import { buildQueueTicket } from './templates/queue-ticket';
import { COLUMNS_80MM, buildRestaurantBill } from './templates/restaurant-bill-80mm';
import { buildRetailReceipt } from './templates/retail-receipt';
import { buildShiftReport } from './templates/shift-report';

/** Every example template with sample data, for the preview script and the tests. */

const at = new Date(2026, 8, 23, 14, 5);

export type Sample = { name: string; description: string; columns: number; build: () => Uint8Array };

export const samples: Sample[] = [
  {
    name: 'retail-receipt',
    description: 'Shop receipt with logo, items, tax, payment and change',
    columns: 32,
    build: () =>
      buildRetailReceipt({
        shop: { name: 'Corner Market', address: 'Av. Reforma 123, Col. Centro, Ciudad de México', phone: '55 1234 5678' },
        receiptNumber: '000482',
        date: at,
        cashier: 'Ana',
        items: [
          { name: 'Café de olla 500 g', quantity: 1, unitPrice: 89.5 },
          { name: 'Pan dulce (concha)', quantity: 3, unitPrice: 12 },
          { name: 'Agua mineral 1.5 L', quantity: 2, unitPrice: 21.9 },
        ],
        taxRate: 0.16,
        paid: { method: 'Cash', amount: 250 },
        footer: 'Thank you for shopping with us. Keep this receipt for returns within 30 days.',
      }),
  },
  {
    name: 'kitchen-order',
    description: 'Kitchen ticket with big table number and modifiers',
    columns: 32,
    build: () =>
      buildKitchenOrder({
        table: '12',
        orderNumber: 57,
        server: 'Luis',
        date: at,
        items: [
          { quantity: 2, name: 'Tacos al pastor', modifiers: ['No onion', 'Extra salsa verde'] },
          { quantity: 1, name: 'Sopa de tortilla' },
          { quantity: 3, name: 'Agua de jamaica', modifiers: ['1 without ice'] },
        ],
        note: 'Guest has a peanut allergy. Please use a clean pan.',
      }),
  },
  {
    name: 'queue-ticket',
    description: 'Take-a-number ticket with one huge number',
    columns: 32,
    build: () =>
      buildQueueTicket({ place: 'City Hall', service: 'Payments & permits', number: 'A-042', ahead: 7, date: at }),
  },
  {
    name: 'shift-report',
    description: 'End-of-shift cash report with a cash difference',
    columns: 32,
    build: () =>
      buildShiftReport({
        register: 'Register 2',
        cashier: 'Ana',
        openedAt: new Date(2026, 8, 23, 7, 0),
        closedAt: new Date(2026, 8, 23, 15, 2),
        salesCount: 84,
        byMethod: [
          { method: 'Cash', amount: 6420.5 },
          { method: 'Card', amount: 9315 },
          { method: 'Transfer', amount: 1200 },
        ],
        refunds: 89.5,
        openingCash: 1000,
        countedCash: 7321,
      }),
  },
  {
    name: 'restaurant-bill-80mm',
    description: '80mm restaurant bill with an item table and tip suggestions',
    columns: COLUMNS_80MM,
    build: () =>
      buildRestaurantBill({
        restaurant: 'La Terraza',
        table: '4',
        guests: 3,
        items: [
          { quantity: 3, name: 'Enchiladas suizas', price: 145 },
          { quantity: 1, name: 'Guacamole con totopos', price: 98 },
          { quantity: 3, name: 'Limonada', price: 38 },
          { quantity: 1, name: 'Flan napolitano', price: 65 },
        ],
        tipRates: [0.1, 0.15, 0.2],
      }),
  },
];

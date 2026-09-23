# @ricka7x/expo-thermal-printer

[![CI](https://github.com/Ricka7x/expo-thermal-printer/actions/workflows/ci.yml/badge.svg)](https://github.com/Ricka7x/expo-thermal-printer/actions/workflows/ci.yml)

Bluetooth ESC/POS thermal printing for Expo apps on **Android** and **iOS**, plus a dependency-free ESC/POS byte builder.

Receipt layouts are up to each app; this package handles the connection and the ESC/POS bytes.

## How each platform connects

| | Android | iOS |
|---|---|---|
| Transport | Bluetooth Classic (SPP/RFCOMM) | Bluetooth Low Energy (GATT) |
| Finding the printer | Paired once in Android's Bluetooth settings, listed instantly | BLE scan from the app |
| `address` | MAC address | CoreBluetooth peripheral UUID (stable per phone) |
| Auto-reconnect | Yes: drop seen via the ACL broadcast (4s heartbeat as backup), then retried every 2 to 15s, once a minute after 5 minutes, paused while the app is in the background | Yes (pending reconnect after a drop, handled by the Bluetooth chip) |

**iOS only works with printers that expose BLE.** iOS doesn't let apps use Bluetooth Classic SPP unless the accessory is MFi certified, and cheap printers aren't. Many 58mm printers are dual mode (Classic + BLE) and work on both platforms. A Classic-only printer works on Android but will never show up in an iOS scan. Check the printer's spec sheet for "BLE" or "Bluetooth 4.0 dual mode" before buying for iOS.

## What's included

- **Native modules:** Kotlin (Android) and Swift/CoreBluetooth (iOS). Both only move bytes; they never format anything.
  - Android: connects over SPP with fallbacks (secure → insecure → RFCOMM channel 1) and a time limit, so a paired printer that's switched off fails in seconds instead of hanging. Writes in small flushed chunks, detects power-off, and keeps retrying until the printer comes back (printers never reconnect to the phone on their own).
  - iOS: scans, connects, and picks the print characteristic from a list of known ones (`18F0/2AF1` first, then ISSC, `E7810A71…`, `FF00`, `FFE0`, then any writable one). Writes are acknowledged (write with response) whenever the printer supports it, at most 100 bytes each, so the printer's buffer can't be overrun. Reconnects after a drop.
- **Transport (`transport.ts`):** permissions, `findPrinters`, connect/disconnect, connection events, and `printBytes`, which paces sends so the printer's small buffer never overflows.
- **`EscPosBuilder` (`escpos.ts`):** pure TypeScript, no dependencies. Alignment, bold, sizes, word wrapping, tear lines, raster images, code page 850 with Spanish accents, ASCII fallback. Also `wrap`, `twoColumns` and `fitColumns` for laying out rows.
- **`usePrinterDisconnected`:** hook for a "printer disconnected" notice.
- **Config plugin:** adds the iOS Bluetooth permission text to Info.plist.

## Requirements

- An Expo **development build** (Expo Go can't load native code).
- Android permissions ship in the library manifest. The module never scans on Android, so it doesn't need the location permission.
- iOS needs `NSBluetoothAlwaysUsageDescription`; the config plugin adds it.
- Bluetooth printing has to be tested on a real phone. Simulators and emulators have no Bluetooth.

## Setup

```sh
npx expo install @ricka7x/expo-thermal-printer
```

Or straight from GitHub, pinned to a release tag (npm builds it on install, so it takes a little longer):

```sh
npm install github:Ricka7x/expo-thermal-printer#v0.1.1
```

In `app.json`:

```json
{
  "expo": {
    "plugins": [
      ["@ricka7x/expo-thermal-printer", { "bluetoothPermission": "Allow $(PRODUCT_NAME) to connect to your receipt printer." }]
    ]
  }
}
```

Then rebuild the native app (`npx expo run:android --device`, `npx expo run:ios --device`, or an EAS build).

## Usage

```ts
import {
  CODEPAGE,
  EscPosBuilder,
  connectToPrinter,
  findPrinters,
  printBytes,
} from '@ricka7x/expo-thermal-printer';

// Android: paired printers. iOS: a 4 second BLE scan, returning every named device nearby.
const printers = await findPrinters({ scanTimeoutMs: 4000 });
// Let the user pick; remember `address` for next time.
await connectToPrinter(printers[0].address);

const receipt = new EscPosBuilder()
  .init()
  .codepage(CODEPAGE.CP850)
  .align('center')
  .bold(true)
  .line('My Shop')
  .bold(false)
  .line('Thank you!')
  .wrapped('Long text like a legal note wraps at word boundaries instead of mid-word.')
  .feedToTear() // feeds 18 lines so the last line clears the tear bar
  .build();

await printBytes(receipt);
```

Errors come as `{ code, message }` with `code` one of `bluetooth_off`, `permission_denied`, `not_connected`, `write_failed`, `unsupported`. Messages are in English; map the codes to your own UI text.

`printBytes` runs jobs one at a time, so two overlapping calls (a double tap) print one after the other instead of mixing their bytes.

## API

**Transport**

| Function | What it does |
|---|---|
| `isPrintingSupported()` | `true` on Android and iOS. |
| `ensureBluetoothPermission()` | Asks for Bluetooth permission if needed. Resolves `true` when granted. |
| `findPrinters({ scanTimeoutMs? })` | Android: paired devices. iOS: BLE scan (default 4000 ms). |
| `connectToPrinter(address)` | Connects; a no-op when already connected to it. iOS gives up after 10 s. |
| `disconnectPrinter()` | Disconnects and stops auto-reconnecting. |
| `printBytes(bytes)` | Sends a job, paced to the printer's speed. Resolves once everything is sent. |
| `isConnected()`, `connectedAddress()`, `isBluetoothEnabled()` | Synchronous status reads. |
| `onConnectionChanged(listener)` | Fires on connect, disconnect, and when the printer turns off or comes back. Returns `{ remove }`. |
| `usePrinterDisconnected()` | React hook: `true` while printing is supported but no printer is connected. |

**Building bytes** (also available from `@ricka7x/expo-thermal-printer/escpos`, which loads in plain Node)

`EscPosBuilder` methods, all chainable: `init()`, `codepage(page)`, `align('left' | 'center' | 'right')`, `bold(on)`, `size(w, h)` (1–8), `text(s)`, `line(s)`, `wrapped(s, { columns, indent })`, `feed(n)`, `feedToTear()`, `tearLine()`, `dashedRule()`, `raster(image, { maxRowsPerStrip })`, `raw(...bytes)`, then `build()` for the `Uint8Array`.

Two rules the builder enforces, because printers get them wrong silently:

- **`align()` only at the start of a line.** Printers apply alignment at the start of a line only; mid-line they ignore it or carry it into the next line. The builder throws if you call it after text on the same line.
- **Images go out in strips of at most 255 rows.** Some printers read only the low byte of an image's height, and print the rest of a taller image as garbage text. Pass a smaller `maxRowsPerStrip` for printers with a very small buffer. `raster()` also throws if the bitmap's data length doesn't match its size.

Helpers: `wrap`, `twoColumns`, `fitColumns`, `encodeCodepage850`, `decodeCodepage850`, `encodeAscii`, `bytesToBase64`, `previewReceipt`, and the constants `CODEPAGE`, `PAPER_58MM_COLUMNS` (32), `PAPER_58MM_WIDTH_DOTS` (384), `TEAR_OFF_FEED_LINES` (18).

Text is encoded as code page 850 by default, which covers Western European accents (á é í ó ú ñ ü ç à ö ß, ¿ ¡ ° and more). Characters it lacks print as their nearest ASCII (`€` → `EUR`, `…` → `...`) rather than garbage. Pass `encodeAscii` as the encoding for printers whose code page is unknown.

## Receipt templates

The package doesn't ship receipt layouts. Each app writes its own template as a function that takes its data and returns bytes. Import from `@ricka7x/expo-thermal-printer/escpos`: it has the builder and the preview but nothing native, so templates also load in Node (unit tests, scripts, a server).

```ts
import { CODEPAGE, EscPosBuilder, twoColumns } from '@ricka7x/expo-thermal-printer/escpos';

type Sale = { shop: string; items: { name: string; price: string }[]; total: string; note: string };

export function buildReceipt(sale: Sale): Uint8Array {
  const b = new EscPosBuilder().init().codepage(CODEPAGE.CP850);

  b.align('center').bold(true).line(sale.shop).bold(false).dashedRule();
  b.align('left');
  for (const item of sale.items) b.line(twoColumns(item.name, item.price));
  b.bold(true).line(twoColumns('Total', sale.total)).bold(false);
  b.wrapped(sale.note);

  return b.feedToTear().build();
}
```

### Examples

[`examples/templates/`](examples/templates) has complete templates, each showing different techniques:

| Template | Shows |
|---|---|
| [`retail-receipt`](examples/templates/retail-receipt.ts) | Logo image, item rows with quantity and unit price, tax, double-size total, change |
| [`kitchen-order`](examples/templates/kitchen-order.ts) | Mixing sizes, double-height items readable from a distance, indented modifiers |
| [`queue-ticket`](examples/templates/queue-ticket.ts) | One huge centred number (4x size) |
| [`shift-report`](examples/templates/shift-report.ts) | Label/value report, flagging a cash difference, signature line |
| [`restaurant-bill-80mm`](examples/templates/restaurant-bill-80mm.ts) | 80mm paper (48 columns), a three-column table, suggested tips |

See them all as ASCII (from a clone of this repo):

```sh
npm run preview                          # every example
npm run preview -- kitchen-order         # just one
```

```
+--------------------------------+
|        T A B L E   1 2         |
|                                |
|           Order #57            |
|Luis            23/09/2026 14:05|
|================================|
|2x Tacos al pastor              |
|                                |
|   - No onion                   |
|   - Extra salsa verde          |
```

### Previewing and testing your own templates

`previewReceipt(bytes, { columns })` turns ESC/POS bytes into text: alignment, double width (`T O T A L`), double height (an extra blank row), feeds and images (as ASCII art). Use it to eyeball a layout in a script, or to test a template without a printer:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewReceipt } from '@ricka7x/expo-thermal-printer/escpos';

import { buildReceipt } from './receipt';

test('receipt fits 58mm paper and shows the total', () => {
  const text = previewReceipt(buildReceipt(sample), { frame: false });
  for (const row of text.split('\n')) assert.ok(row.length <= 32);
  assert.match(text, /Total\s+\$196\.39/);
});
```

The preview works on a character grid, so it can't show half-character offsets the printer produces (a centred 31-character rule sits half a character in from each side on paper), bold, or exact image proportions. Check the final look on a real printer.

## Limitations

- **One printer at a time.** Connecting to another printer drops the current one.
- **58mm defaults.** Column helpers default to 32 columns; pass `columns` for 80mm paper (usually 48).
- **Android never scans.** The printer has to be paired in Android's Bluetooth settings first.
- **iOS needs BLE** (see above), and the app must be in the foreground to scan, connect and print. Background Bluetooth isn't configured.
- **No printer status.** ESC/POS printers over Bluetooth don't reliably report paper-out or cover-open, so a job can be "sent" and not printed.
- **No auto-cutter command.** End jobs with `feedToTear()` and tear the paper by hand.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| iOS scan doesn't list the printer | It's Bluetooth Classic only (no BLE), it's off, or another phone is connected to it. |
| Android list is empty | The printer isn't paired in Android's Bluetooth settings. |
| Accents print as other symbols | The printer's default code page differs; call `codepage(CODEPAGE.CP850)` after `init()`, or switch to `encodeAscii`. |
| The last lines stay inside the printer | End the job with `feedToTear()`. |
| The end of a long receipt is missing | Send it with `printBytes`, which paces the data; don't write to the native module directly. |
| Garbage text under an image, or white lines through it | The printer's buffer is small: lower `maxRowsPerStrip` (for example 24). |
| Text is aligned one line late | Some code wrote text before `align()` on the same line; the builder now throws for this. |
| App crashes on iOS the first time Bluetooth is used | `NSBluetoothAlwaysUsageDescription` is missing: add the config plugin and rebuild. |

## Development

```sh
npm install
npm run check     # typecheck, tests (Node, no hardware) and build
npm run preview   # the example templates as ASCII
```

`npm run build` compiles `src/` to `build/`, which is what apps import. It also runs on `npm install` and `npm pack` through `prepare`.

## Status

- Android: tested on real phones with an MP58C6 58mm printer.
- iOS: tested on an iPhone with the same MP58C6, which is dual mode and shows up in the BLE scan.

## License

[MIT](LICENSE)

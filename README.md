# expo-thermal-printer

Bluetooth ESC/POS thermal printing for Expo apps on **Android** and **iOS**, plus a dependency-free ESC/POS byte builder.

Receipt layouts are up to each app; this package handles the connection and the ESC/POS bytes.

## How each platform connects

| | Android | iOS |
|---|---|---|
| Transport | Bluetooth Classic (SPP/RFCOMM) | Bluetooth Low Energy (GATT) |
| Finding the printer | Paired once in Android's Bluetooth settings, listed instantly | BLE scan from the app |
| `address` | MAC address | CoreBluetooth peripheral UUID (stable per phone) |
| Auto-reconnect | Yes (ACL broadcast + 4s heartbeat) | Yes (pending reconnect after a drop) |

**iOS only works with printers that expose BLE.** iOS doesn't let apps use Bluetooth Classic SPP unless the accessory is MFi certified, and cheap printers aren't. Many 58mm printers are dual mode (Classic + BLE) and work on both platforms. A Classic-only printer works on Android but will never show up in an iOS scan. Check the printer's spec sheet for "BLE" or "Bluetooth 4.0 dual mode" before buying for iOS.

## What's included

- **Native modules:** Kotlin (Android) and Swift/CoreBluetooth (iOS). Both only move bytes; they never format anything.
  - Android: connects over SPP with fallbacks (secure → insecure → RFCOMM channel 1), writes in small flushed chunks, detects power-off, reconnects when the printer comes back.
  - iOS: scans, connects, picks the writable characteristic (known printer services first: `18F0`, `FF00`, `FFE0`, ISSC, `E7810A71…`, then any writable one), writes in MTU-sized chunks with flow control, reconnects after a drop.
- **Transport (`transport.ts`):** permissions, `findPrinters`, connect/disconnect, connection events, and `printBytes`, which paces sends so the printer's small buffer never overflows.
- **`EscPosBuilder` (`escpos.ts`):** pure TypeScript, no dependencies. Alignment, bold, sizes, tear lines, raster images, code page 850 with Spanish accents, ASCII fallback.
- **`usePrinterDisconnected`:** hook for a "printer disconnected" notice.
- **Config plugin:** adds the iOS Bluetooth permission text to Info.plist.

## Requirements

- An Expo **development build** (Expo Go can't load native code).
- Android permissions ship in the library manifest. The module never scans on Android, so it doesn't need the location permission.
- iOS needs `NSBluetoothAlwaysUsageDescription`; the config plugin adds it.
- Bluetooth printing has to be tested on a real phone. Simulators and emulators have no Bluetooth.

## Setup

Local for now. From the Expo app:

```sh
npm install ../expo-thermal-printer
```

In `app.json`:

```json
{
  "expo": {
    "plugins": [
      ["expo-thermal-printer", { "bluetoothPermission": "Allow $(PRODUCT_NAME) to connect to your receipt printer." }]
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
} from 'expo-thermal-printer';

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
  .feedToTear() // feeds 18 lines so the last line clears the tear bar
  .build();

await printBytes(receipt);
```

Errors come as `{ code, message }` with `code` one of `bluetooth_off`, `permission_denied`, `not_connected`, `write_failed`, `unsupported`. Messages are in English; map the codes to your own UI text.

## Development

```sh
npm install
npm test          # ESC/POS and base64 tests, in Node, no hardware
npm run typecheck
```

## Status

- Android: tested on real phones with an MP58C6 58mm printer.
- iOS: tested on an iPhone 11 with the same MP58C6, which is dual mode and shows up in the BLE scan.

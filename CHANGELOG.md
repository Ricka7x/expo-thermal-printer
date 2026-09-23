# Changelog

## 0.1.0

First release.

- Android: Bluetooth Classic (SPP) transport for paired printers, with connection fallbacks, paced writes, power-off detection and auto-reconnect.
- iOS: BLE transport through CoreBluetooth, with scanning, automatic write characteristic selection, flow-controlled writes and auto-reconnect.
- Config plugin for the iOS Bluetooth permission text.
- `EscPosBuilder` with alignment, bold, sizes, word wrapping, tear lines, raster images and `feedToTear()`.
- Code page 850 encoding for Western European text, with readable ASCII fallbacks.
- Print jobs run one at a time.
- `previewReceipt()` renders ESC/POS bytes as ASCII for terminals and tests.
- `@ricka7x/expo-thermal-printer/escpos` entry with the builder and preview only, loadable in plain Node.
- Example templates (retail receipt, kitchen order, queue ticket, shift report, 80mm restaurant bill) with tests and `npm run preview`.
- Images are sent in strips of at most 255 rows; `raster()` validates the data length.
- `align()` throws when called mid-line.
- iOS writes with response when the printer supports it, at most 100 bytes per write, to a characteristic chosen from a list of known printer ones.
- Android connects give up after 8 seconds per attempt and 15 seconds overall.
- Android: the ACL receiver is exported, so Bluetooth disconnect broadcasts actually arrive (Android 12+ blocked them before). After an involuntary drop a reconnect loop retries every 2 to 15 seconds until the printer is back, slowing to once a minute after 5 minutes. It pauses while the app is in the background and tries at once when it returns.

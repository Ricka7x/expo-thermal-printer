# Changelog

## 0.1.0

First release.

- Android: Bluetooth Classic (SPP) transport for paired printers, with connection fallbacks, paced writes, power-off detection and auto-reconnect.
- iOS: BLE transport through CoreBluetooth, with scanning, automatic write characteristic selection, flow-controlled writes and auto-reconnect.
- Config plugin for the iOS Bluetooth permission text.
- `EscPosBuilder` with alignment, bold, sizes, word wrapping, tear lines, raster images and `feedToTear()`.
- Code page 850 encoding for Western European text, with readable ASCII fallbacks.
- Print jobs run one at a time.

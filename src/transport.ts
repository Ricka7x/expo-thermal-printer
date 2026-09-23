import { PermissionsAndroid, Platform } from 'react-native';

import { bytesToBase64 } from './base64';
import type { ConnectionChangedEvent, PrinterDevice } from './ThermalPrinter.types';
import { getThermalPrinterModule } from './ThermalPrinterModule';

/**
 * App-level transport: permission handling, printer discovery and sending
 * already-built ESC/POS bytes. Building the bytes is ./escpos.ts's job, so this
 * file only deals with talking to the device.
 *
 * Android talks Bluetooth Classic (SPP) to a printer paired in system
 * settings; iOS talks BLE to a printer found by scanning. The functions below
 * hide that difference.
 *
 * The native module is resolved lazily inside each function, never at import
 * time: expo-router eagerly imports every route file during startup, so a
 * module-scope requireNativeModule would run at boot.
 */

export { bytesToBase64 };

export type TransportError = {
  code: 'bluetooth_off' | 'permission_denied' | 'not_connected' | 'write_failed' | 'unsupported';
  message: string;
};

const UNSUPPORTED: TransportError = {
  code: 'unsupported',
  message: 'Bluetooth printing is only available on Android and iOS',
};

/** How long `findPrinters` scans on iOS when no timeout is given. */
const DEFAULT_SCAN_MS = 4000;

export function isPrintingSupported(): boolean {
  return Platform.OS === 'android' || Platform.OS === 'ios';
}

/**
 * On iOS this reads false until the app has asked for Bluetooth permission,
 * because creating the Bluetooth manager is what triggers the system prompt.
 */
export function isBluetoothEnabled(): boolean {
  if (!isPrintingSupported()) return false;
  return getThermalPrinterModule().isBluetoothEnabled();
}

export function isConnected(): boolean {
  if (!isPrintingSupported()) return false;
  return getThermalPrinterModule().isConnected();
}

export function connectedAddress(): string | null {
  if (!isPrintingSupported()) return null;
  return getThermalPrinterModule().connectedAddress();
}

/**
 * Android 12+: requests BLUETOOTH_CONNECT at runtime (older versions grant it
 * at install time). iOS: shows the system Bluetooth prompt the first time.
 */
export async function ensureBluetoothPermission(): Promise<boolean> {
  if (!isPrintingSupported()) return false;
  const module = getThermalPrinterModule();
  if (module.hasPermission()) return true;

  if (Platform.OS === 'ios') {
    return (await module.requestPermission?.()) ?? false;
  }

  if (typeof Platform.Version === 'number' && Platform.Version < 31) return true;
  const result = await PermissionsAndroid.request(
    'android.permission.BLUETOOTH_CONNECT' as Parameters<typeof PermissionsAndroid.request>[0]
  );
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

/**
 * Printers the user can pick from.
 *
 * Android: the bonded devices, instantly. Pairing happens once in Android's
 * Bluetooth settings. iOS: a BLE scan lasting `scanTimeoutMs`, returning every
 * named device nearby (plus the connected printer, which stops advertising
 * while connected). iOS apps can't pair in settings, and the scan can't tell a
 * printer from headphones, so show names and let the user choose.
 */
export async function findPrinters(options: { scanTimeoutMs?: number } = {}): Promise<PrinterDevice[]> {
  if (!isPrintingSupported()) return [];
  const granted = await ensureBluetoothPermission();
  if (!granted) {
    throw { code: 'permission_denied', message: 'Bluetooth permission is needed to find the printer' } satisfies TransportError;
  }
  const module = getThermalPrinterModule();
  try {
    if (Platform.OS === 'ios') {
      return (await module.scanDevices?.(options.scanTimeoutMs ?? DEFAULT_SCAN_MS)) ?? [];
    }
    return (await module.pairedDevices?.()) ?? [];
  } catch (error) {
    throw toTransportError(error, 'not_connected');
  }
}

export async function connectToPrinter(address: string): Promise<void> {
  if (!isPrintingSupported()) throw UNSUPPORTED;
  const module = getThermalPrinterModule();
  // On iOS the radio state isn't known synchronously before the first request,
  // so the native side reports "off" as an error instead.
  if (Platform.OS === 'android' && !module.isBluetoothEnabled()) {
    throw { code: 'bluetooth_off', message: 'Turn on Bluetooth on this device' } satisfies TransportError;
  }
  const granted = await ensureBluetoothPermission();
  if (!granted) {
    throw { code: 'permission_denied', message: 'Bluetooth permission is needed' } satisfies TransportError;
  }
  try {
    await module.connect(address);
  } catch (error) {
    throw toTransportError(error, 'not_connected');
  }
}

export async function disconnectPrinter(): Promise<void> {
  if (!isPrintingSupported()) return;
  await getThermalPrinterModule().disconnect();
}

/**
 * Notifies of real connection changes as they happen: a printer power-off is
 * detected on the native side (Android: ACL disconnect or a failed heartbeat;
 * iOS: CoreBluetooth's disconnect), or a write fails mid-print, not just when
 * the screen re-reads state on focus. Returns a no-op subscription on
 * unsupported platforms so callers don't need to branch.
 */
export function onConnectionChanged(listener: (event: ConnectionChangedEvent) => void): { remove: () => void } {
  if (!isPrintingSupported()) return { remove: () => {} };
  return getThermalPrinterModule().addListener('onConnectionChanged', listener);
}

/**
 * Bytes per second we allow ourselves to send.
 *
 * A cheap printer consumes roughly 0.43 KB/s of ESC/POS when printing at about
 * 50mm/s, and it has no flow control. Anything sent faster than it consumes
 * accumulates in its input buffer, which on these models is only a few KB, and
 * the overflow is dropped silently: that is how a long receipt loses its
 * total. Pacing to the consumption rate means the buffer never grows and the
 * length of the job stops mattering.
 *
 * It costs nothing in practice: the paper takes this long to come out anyway,
 * so waiting is what the printer is doing regardless. It also makes a
 * "printed" message honest, because it is only shown once the printer has
 * consumed it all.
 */
const SEND_BYTES_PER_SECOND = 400;

/** Bytes per bridge call. Small enough to stay well inside any socket buffer. */
const CHUNK_BYTES = 128;

/** Pause derived from the rate above, so the two cannot drift apart. */
const CHUNK_PAUSE_MS = Math.round((CHUNK_BYTES / SEND_BYTES_PER_SECOND) * 1000);

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Jobs run one at a time. printBytes sends a job as many small writes with
 * pauses between them, so two overlapping calls (a double tap on "print")
 * would interleave their chunks and the printer would get both receipts mixed
 * together.
 */
let printQueue: Promise<void> = Promise.resolve();

/**
 * Sends a built ESC/POS payload over the already-connected printer, after any
 * job already printing. Keep printing decoupled from whatever business action
 * triggered it: a failed print should never undo a sale that is already
 * recorded.
 */
export function printBytes(bytes: Uint8Array): Promise<void> {
  const job = printQueue.then(() => sendJob(bytes));
  // The next job waits for this one to settle, not to succeed.
  printQueue = job.catch(() => {});
  return job;
}

async function sendJob(bytes: Uint8Array): Promise<void> {
  if (!isPrintingSupported()) throw UNSUPPORTED;
  const module = getThermalPrinterModule();
  if (!module.isConnected()) {
    throw { code: 'not_connected', message: 'The printer is not connected' } satisfies TransportError;
  }
  try {
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
      await module.write(bytesToBase64(chunk));
      // No pause after the last chunk: nothing follows it to overrun.
      if (offset + CHUNK_BYTES < bytes.length) {
        await pause(CHUNK_PAUSE_MS);
      }
    }
  } catch (error) {
    throw toTransportError(error, 'write_failed');
  }
}

/**
 * Both native modules name their exceptions the same way, so Expo infers the
 * same codes on each (ERR_BLUETOOTH_UNAVAILABLE, ERR_BLUETOOTH_PERMISSION, ...).
 */
function toTransportError(error: unknown, fallback: TransportError['code']): TransportError {
  const nativeCode =
    error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : '';
  const code: TransportError['code'] = nativeCode.includes('BLUETOOTH_UNAVAILABLE')
    ? 'bluetooth_off'
    : nativeCode.includes('BLUETOOTH_PERMISSION')
      ? 'permission_denied'
      : nativeCode.includes('PRINTER_NOT_CONNECTED')
        ? 'not_connected'
        : fallback;
  return { code, message: describeError(error) };
}

function describeError(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return 'Communication with the printer failed';
}

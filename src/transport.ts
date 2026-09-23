import { PermissionsAndroid, Platform } from 'react-native';

import { getThermalPrinterModule } from './ThermalPrinterModule';
import type { ConnectionChangedEvent, PairedPrinter } from './ThermalPrinter.types';
import { bytesToBase64 } from './base64';

/**
 * App-level transport: permission handling, printer selection and sending
 * already-built ESC/POS bytes. Building the bytes is ./escpos.ts's job, so this
 * file only deals with talking to the device.
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

export function isPrintingSupported(): boolean {
  return Platform.OS === 'android';
}

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
 * Requests BLUETOOTH_CONNECT at runtime on Android 12+. Older versions grant it
 * at install time, so this is a no-op there.
 */
export async function ensureBluetoothPermission(): Promise<boolean> {
  if (!isPrintingSupported()) return false;
  const module = getThermalPrinterModule();
  if (module.hasPermission()) return true;
  if (typeof Platform.Version === 'number' && Platform.Version < 31) return true;

  const result = await PermissionsAndroid.request(
    'android.permission.BLUETOOTH_CONNECT' as Parameters<typeof PermissionsAndroid.request>[0]
  );
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

/** Bonded devices. Pairing itself happens once in Android's Bluetooth settings. */
export async function listPairedPrinters(): Promise<PairedPrinter[]> {
  if (!isPrintingSupported()) return [];
  const granted = await ensureBluetoothPermission();
  if (!granted) {
    throw {
      code: 'permission_denied',
      message: 'Se necesita permiso de Bluetooth para buscar la impresora',
    } satisfies TransportError;
  }
  return getThermalPrinterModule().pairedDevices();
}

export async function connectToPrinter(address: string): Promise<void> {
  if (!isPrintingSupported()) {
    throw { code: 'unsupported', message: 'La impresión solo está disponible en Android' } satisfies TransportError;
  }
  const module = getThermalPrinterModule();
  if (!module.isBluetoothEnabled()) {
    throw { code: 'bluetooth_off', message: 'Enciende el Bluetooth del teléfono' } satisfies TransportError;
  }
  const granted = await ensureBluetoothPermission();
  if (!granted) {
    throw { code: 'permission_denied', message: 'Se necesita permiso de Bluetooth' } satisfies TransportError;
  }
  try {
    await module.connect(address);
  } catch (error) {
    throw { code: 'not_connected', message: describeError(error) } satisfies TransportError;
  }
}

export async function disconnectPrinter(): Promise<void> {
  if (!isPrintingSupported()) return;
  await getThermalPrinterModule().disconnect();
}

/**
 * Notifies of real connection changes as they happen: a printer power-off is
 * detected on the native side (ACL disconnect) or a write fails mid-print, not
 * just when the screen re-reads state on focus. Returns a no-op subscription on
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
 * 50mm/s, and it has no flow control over RFCOMM. Anything sent faster than it
 * consumes accumulates in its input buffer, which on these models is only a few
 * KB, and the overflow is dropped silently: that is how a long shift-close strip
 * loses its total. Pacing to the consumption rate means the buffer never grows
 * and the length of the job stops mattering.
 *
 * It costs nothing in practice: the paper takes this long to come out anyway, so
 * waiting is what the printer is doing regardless. It also makes the "printed"
 * message honest, because it is only shown once the printer has consumed it all.
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
 * Sends a built ESC/POS payload over the already-connected socket. Keep
 * printing decoupled from whatever business action triggered it: a failed
 * print should never undo a sale that is already recorded.
 */
export async function printBytes(bytes: Uint8Array): Promise<void> {
  if (!isPrintingSupported()) {
    throw { code: 'unsupported', message: 'La impresión solo está disponible en Android' } satisfies TransportError;
  }
  const module = getThermalPrinterModule();
  if (!module.isConnected()) {
    throw { code: 'not_connected', message: 'La impresora no está conectada' } satisfies TransportError;
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
    throw { code: 'write_failed', message: describeError(error) } satisfies TransportError;
  }
}

function describeError(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return 'Falló la comunicación con la impresora';
}

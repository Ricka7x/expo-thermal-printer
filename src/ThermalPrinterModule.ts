import { NativeModule, requireNativeModule } from 'expo';

import type { PrinterDevice, ThermalPrinterModuleEvents } from './ThermalPrinter.types';

declare class ThermalPrinterModuleType extends NativeModule<ThermalPrinterModuleEvents> {
  isBluetoothEnabled(): boolean;
  hasPermission(): boolean;
  isConnected(): boolean;
  connectedAddress(): string | null;
  /** Android only: bonded devices. */
  pairedDevices?(): Promise<PrinterDevice[]>;
  /** iOS only: named BLE peripherals seen within the timeout. */
  scanDevices?(timeoutMs: number): Promise<PrinterDevice[]>;
  /** iOS only: shows the system Bluetooth prompt if it hasn't been answered. */
  requestPermission?(): Promise<boolean>;
  connect(address: string): Promise<boolean>;
  /** Raw ESC/POS bytes, base64 encoded. */
  write(base64: string): Promise<boolean>;
  disconnect(): Promise<boolean>;
}

let cached: ThermalPrinterModuleType | null = null;

/**
 * Resolves the native module on first use, never at import time.
 *
 * This matters: expo-router eagerly imports every file in src/app at startup,
 * so a module-scope requireNativeModule runs during app boot. Resolving the
 * native module that early hard-crashed an app on a real Android 12 device
 * (SIGSEGV on the JS thread) even though the module was present in the APK.
 * Keeping it lazy means importing a route is always safe.
 */
export function getThermalPrinterModule(): ThermalPrinterModuleType {
  if (!cached) {
    cached = requireNativeModule<ThermalPrinterModuleType>('ThermalPrinter');
  }
  return cached;
}

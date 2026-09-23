/**
 * Web has no Bluetooth Classic transport. The app targets Android only, but
 * Metro still resolves this file when the web platform is bundled, so it fails
 * loudly rather than crashing on a missing native module.
 *
 * Same lazy shape as the native file so import order can never crash a boot.
 */
import type { PairedPrinter, ThermalPrinterModuleEvents } from './ThermalPrinter.types';

type WebStub = {
  isBluetoothEnabled(): boolean;
  hasPermission(): boolean;
  isConnected(): boolean;
  connectedAddress(): string | null;
  pairedDevices(): Promise<PairedPrinter[]>;
  connect(address: string): Promise<boolean>;
  write(base64: string): Promise<boolean>;
  disconnect(): Promise<boolean>;
};

export type { ThermalPrinterModuleEvents };

const message = 'La impresión por Bluetooth solo está disponible en Android.';

let cached: WebStub | null = null;

export function getThermalPrinterModule(): WebStub {
  if (!cached) {
    cached = {
      isBluetoothEnabled: () => false,
      hasPermission: () => false,
      isConnected: () => false,
      connectedAddress: () => null,
      pairedDevices: async () => {
        throw new Error(message);
      },
      connect: async () => {
        throw new Error(message);
      },
      write: async () => {
        throw new Error(message);
      },
      disconnect: async () => true,
    };
  }
  return cached;
}

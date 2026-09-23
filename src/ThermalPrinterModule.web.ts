/**
 * The web has no Bluetooth transport for these printers. Metro still resolves
 * this file when the web platform is bundled, so it fails loudly rather than
 * crashing on a missing native module.
 *
 * Same lazy shape as the native file so import order can never crash a boot.
 */
import type { PrinterDevice, ThermalPrinterModuleEvents } from './ThermalPrinter.types';

type WebStub = {
  isBluetoothEnabled(): boolean;
  hasPermission(): boolean;
  isConnected(): boolean;
  connectedAddress(): string | null;
  pairedDevices(): Promise<PrinterDevice[]>;
  connect(address: string): Promise<boolean>;
  write(base64: string): Promise<boolean>;
  disconnect(): Promise<boolean>;
};

export type { ThermalPrinterModuleEvents };

const message = 'Bluetooth printing is only available on Android and iOS.';

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

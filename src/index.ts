export { getThermalPrinterModule } from './ThermalPrinterModule';
export type { PrinterDevice, ConnectionChangedEvent } from './ThermalPrinter.types';

export {
  type TransportError,
  isPrintingSupported,
  isBluetoothEnabled,
  isConnected,
  connectedAddress,
  ensureBluetoothPermission,
  findPrinters,
  connectToPrinter,
  disconnectPrinter,
  onConnectionChanged,
  printBytes,
} from './transport';
export { usePrinterDisconnected } from './use-printer-status';

export * from './pure';

export { getThermalPrinterModule } from './ThermalPrinterModule';
export type { PairedPrinter, ConnectionChangedEvent } from './ThermalPrinter.types';

export {
  type TransportError,
  isPrintingSupported,
  isBluetoothEnabled,
  isConnected,
  connectedAddress,
  ensureBluetoothPermission,
  listPairedPrinters,
  connectToPrinter,
  disconnectPrinter,
  onConnectionChanged,
  printBytes,
} from './transport';
export { usePrinterDisconnected } from './use-printer-status';

export {
  EscPosBuilder,
  CODEPAGE,
  LF,
  PAPER_58MM_COLUMNS,
  PAPER_58MM_WIDTH_DOTS,
  encodeCodepage850,
  encodeAscii,
  fitColumns,
  twoColumns,
  type Align,
  type Codepage,
  type RasterImage,
  type TextEncoderFn,
} from './escpos';
export { bytesToBase64 } from './base64';

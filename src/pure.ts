/**
 * The parts of the package with no React Native or Expo imports: building
 * bytes and previewing them. Import from "@ricka7x/expo-thermal-printer/escpos" in
 * Node (unit tests, scripts, a server building receipts); the main entry
 * pulls in the native module and can't load outside an app.
 */
export {
  EscPosBuilder,
  CODEPAGE,
  LF,
  PAPER_58MM_COLUMNS,
  PAPER_58MM_WIDTH_DOTS,
  TEAR_OFF_FEED_LINES,
  encodeCodepage850,
  encodeAscii,
  decodeCodepage850,
  fitColumns,
  twoColumns,
  wrap,
  type WrapOptions,
  type Align,
  type Codepage,
  type RasterImage,
  type TextEncoderFn,
} from './escpos.js';
export { previewReceipt, type PreviewOptions } from './preview.js';
export { bytesToBase64 } from './base64.js';

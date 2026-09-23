/**
 * Renders ESC/POS bytes as plain text, so a receipt layout can be checked in a
 * terminal or a unit test without a printer.
 *
 * It understands the commands EscPosBuilder emits: alignment, character size,
 * feeds, line feeds and raster images (drawn as ASCII art). Bold has no plain
 * text equivalent and is ignored. Double height is shown as an extra blank
 * line under the text, so vertical spacing still reads right. Unknown ESC and
 * GS commands are skipped with one parameter byte, which is right for most
 * single-parameter commands but not guaranteed for ones added with raw().
 *
 * Pure TypeScript with no React Native imports: safe to run in Node.
 */
import { PAPER_58MM_COLUMNS, PAPER_58MM_WIDTH_DOTS, decodeCodepage850, type Align } from './escpos.js';

export type PreviewOptions = {
  /** Characters per line. Defaults to 58mm paper's 32. */
  columns?: number;
  /** Printable width in dots, used to scale images. Defaults to 58mm paper's 384. */
  widthDots?: number;
  /** Draw a box around the receipt. Defaults to true. */
  frame?: boolean;
  /** Feeds longer than this collapse into one "[ n blank lines ]" row. Defaults to 3. */
  maxBlankLines?: number;
};

const ESC = 0x1b;
const GS = 0x1d;
const DLE = 0x10;
const LF = 0x0a;

const ALIGN_BY_CODE: Record<number, Align> = { 0: 'left', 1: 'center', 2: 'right', 48: 'left', 49: 'center', 50: 'right' };

/** Image coverage to character, darkest last. */
const SHADES = [' ', '.', '+', '#'];

export function previewReceipt(bytes: Uint8Array | number[], options: PreviewOptions = {}): string {
  const columns = options.columns ?? PAPER_58MM_COLUMNS;
  const widthDots = options.widthDots ?? PAPER_58MM_WIDTH_DOTS;
  const frame = options.frame ?? true;
  const maxBlankLines = options.maxBlankLines ?? 3;
  const data = Array.from(bytes);

  const rows: string[] = [];
  let align: Align = 'left';
  let widthMul = 1;
  let heightMul = 1;
  let lineHeightMul = 1;
  /** Current line, already widened for double-width characters. */
  let line = '';

  const place = (text: string, lineAlign: Align) => {
    const pad = Math.max(0, columns - text.length);
    if (lineAlign === 'center') return ' '.repeat(Math.floor(pad / 2)) + text + ' '.repeat(Math.ceil(pad / 2));
    if (lineAlign === 'right') return ' '.repeat(pad) + text;
    return text + ' '.repeat(pad);
  };

  const endLine = () => {
    // The printer wraps a line that runs past the paper, so the preview does too.
    const chunks = line.length === 0 ? [''] : [];
    for (let i = 0; i < line.length; i += columns) chunks.push(line.slice(i, i + columns));
    for (const chunk of chunks) {
      rows.push(place(chunk, align));
      for (let extra = 1; extra < lineHeightMul; extra++) rows.push(' '.repeat(columns));
    }
    line = '';
    lineHeightMul = heightMul;
  };

  const feed = (count: number) => {
    if (line.length > 0) {
      endLine();
      count -= 1;
    }
    if (count <= 0) return;
    if (count > maxBlankLines) {
      rows.push(place(`[ ${count} blank lines ]`, 'center'));
    } else {
      for (let i = 0; i < count; i++) rows.push(' '.repeat(columns));
    }
  };

  const drawImage = (bytesPerRow: number, height: number, start: number) => {
    const imageWidthDots = bytesPerRow * 8;
    const dotsPerColumn = widthDots / columns;
    // A text line is about twice as tall as a character is wide.
    const dotsPerRow = dotsPerColumn * 2;
    const imageColumns = Math.max(1, Math.round(imageWidthDots / dotsPerColumn));
    const imageRows = Math.max(1, Math.round(height / dotsPerRow));
    const isSet = (x: number, y: number) => {
      const byte = data[start + y * bytesPerRow + (x >> 3)] ?? 0;
      return (byte >> (7 - (x & 7))) & 1;
    };
    for (let r = 0; r < imageRows; r++) {
      let text = '';
      for (let c = 0; c < imageColumns; c++) {
        const x0 = Math.floor((c * imageWidthDots) / imageColumns);
        const x1 = Math.max(x0 + 1, Math.floor(((c + 1) * imageWidthDots) / imageColumns));
        const y0 = Math.floor((r * height) / imageRows);
        const y1 = Math.max(y0 + 1, Math.floor(((r + 1) * height) / imageRows));
        let set = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set += isSet(x, y);
        const coverage = set / ((x1 - x0) * (y1 - y0));
        text += SHADES[Math.min(SHADES.length - 1, Math.ceil(coverage * (SHADES.length - 1)))];
      }
      rows.push(place(text.slice(0, columns), align));
    }
  };

  let i = 0;
  while (i < data.length) {
    const byte = data[i];
    if (byte === LF) {
      endLine();
      i += 1;
    } else if (byte === ESC) {
      const command = data[i + 1];
      const param = data[i + 2] ?? 0;
      if (command === 0x40) {
        align = 'left';
        widthMul = 1;
        heightMul = 1;
        lineHeightMul = 1;
        i += 2;
      } else if (command === 0x61) {
        align = ALIGN_BY_CODE[param] ?? 'left';
        i += 3;
      } else if (command === 0x64) {
        feed(param);
        i += 3;
      } else {
        // ESC t (code page), ESC E (bold) and other one-parameter commands.
        i += 3;
      }
    } else if (byte === GS) {
      const command = data[i + 1];
      if (command === 0x21) {
        const n = data[i + 2] ?? 0;
        widthMul = ((n >> 4) & 0x0f) + 1;
        heightMul = (n & 0x0f) + 1;
        if (line.length === 0) lineHeightMul = heightMul;
        else lineHeightMul = Math.max(lineHeightMul, heightMul);
        i += 3;
      } else if (command === 0x76 && data[i + 2] === 0x30) {
        const bytesPerRow = (data[i + 4] ?? 0) | ((data[i + 5] ?? 0) << 8);
        const height = (data[i + 6] ?? 0) | ((data[i + 7] ?? 0) << 8);
        if (line.length > 0) endLine();
        drawImage(bytesPerRow, height, i + 8);
        i += 8 + bytesPerRow * height;
      } else {
        i += 3;
      }
    } else if (byte === DLE) {
      // DLE EOT n: real-time status query (the connection heartbeat). Prints nothing.
      i += 3;
    } else if (byte < 0x20) {
      i += 1;
    } else {
      const char = decodeCodepage850(byte);
      line += char + ' '.repeat(widthMul - 1);
      if (heightMul > lineHeightMul) lineHeightMul = heightMul;
      i += 1;
    }
  }
  if (line.length > 0) endLine();

  if (!frame) return rows.join('\n');
  const border = '+' + '-'.repeat(columns) + '+';
  return [border, ...rows.map((row) => `|${row}|`), border].join('\n');
}

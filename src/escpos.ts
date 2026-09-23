/**
 * Minimal ESC/POS byte builder for cheap 58mm thermal printers (203dpi,
 * 384 dots/line). First built and tested against an MP58C6.
 *
 * Deliberately dependency-free and pure TypeScript: every function returns
 * bytes, nothing touches Bluetooth. That keeps the layout logic unit-testable
 * without hardware, and means the transport (native module or library) can be
 * swapped without touching a single line of print formatting.
 *
 * Reference: ESC/POS command set. Commands used here are the lowest common
 * denominator supported by cheap 58mm printers, preferred over any vendor SDK.
 */

/** ESC (0x1B) and GS (0x1D) prefixes plus the commands we use. */
const ESC = 0x1b;
const GS = 0x1d;

export const LF = 0x0a;

/** 58mm paper at 203dpi is 384 dots wide; 12x24 font A fits 32 columns. */
export const PAPER_58MM_COLUMNS = 32;
export const PAPER_58MM_WIDTH_DOTS = 384;

export type Align = 'left' | 'center' | 'right';

const ALIGN_CODE: Record<Align, number> = { left: 0, center: 1, right: 2 };

/**
 * Character code tables worth knowing for Spanish text. Cheap printers ship
 * with different defaults, which is why "ó" and "ñ" printing as garbage is the
 * classic ESC/POS failure. We select a table
 * explicitly rather than trusting the factory default.
 */
export const CODEPAGE = {
  CP437: 0, // default on many units, no accents
  CP850: 2, // Latin-1 with Spanish accents, common on these printers
  CP858: 19,
  CP1252: 16,
} as const;

export type Codepage = (typeof CODEPAGE)[keyof typeof CODEPAGE];

/** Accumulates ESC/POS bytes in a growable array. */
export class EscPosBuilder {
  private bytes: number[] = [];

  raw(...values: number[]): this {
    this.bytes.push(...values);
    return this;
  }

  /** ESC @ : reset the printer to its power-on defaults. Start every job. */
  init(): this {
    return this.raw(ESC, 0x40);
  }

  /** ESC t n : select the character code table (affects accented characters). */
  codepage(page: Codepage): this {
    return this.raw(ESC, 0x74, page);
  }

  /** ESC a n : alignment for subsequent lines. */
  align(align: Align): this {
    return this.raw(ESC, 0x61, ALIGN_CODE[align]);
  }

  /** ESC E n : emphasized (bold) mode. */
  bold(on: boolean): this {
    return this.raw(ESC, 0x45, on ? 1 : 0);
  }

  /**
   * GS ! n : character size multiplier. n packs width/height each minus one,
   * so size 2 (double width and height) is 0x11.
   */
  size(widthMultiplier = 1, heightMultiplier = 1): this {
    const n = (((widthMultiplier - 1) & 0x0f) << 4) | ((heightMultiplier - 1) & 0x0f);
    return this.raw(GS, 0x21, n);
  }

  /** ESC d n : feed n blank lines. */
  feed(lines = 1): this {
    return this.raw(ESC, 0x64, lines);
  }

  /** Encodes and appends text, converting line breaks to ESC/POS line feeds. */
  text(value: string, encoding: TextEncoderFn = encodeCodepage850): this {
    for (const byte of encoding(value)) {
      if (byte === LF) {
        this.raw(LF);
      } else {
        this.raw(byte);
      }
    }
    return this;
  }

  /** Appends a text line followed by a line feed. */
  line(value = '', encoding?: TextEncoderFn): this {
    this.text(value, encoding);
    return this.raw(LF);
  }

  /**
   * A visible tear line, for printers without an auto-cutter (the MP58C6 has
   * none): print a rule and tear the paper along it.
   */
  tearLine(char = '-', columns = PAPER_58MM_COLUMNS): this {
    return this.line(char.repeat(columns));
  }

  /** Dashed rule ("- - -"), a lighter-looking tear line. */
  dashedRule(columns = PAPER_58MM_COLUMNS): this {
    let rule = '';
    while (rule.length < columns) rule += '- ';
    return this.line(rule.slice(0, columns));
  }

  /**
   * GS v 0 : raster bit image. `bitmap` is already 1-bit packed, row-major,
   * MSB first, with each row padded to whole bytes.
   */
  raster(bitmap: RasterImage): this {
    if (bitmap.widthDots <= 0 || bitmap.heightDots <= 0) return this;
    const bytesPerRow = Math.ceil(bitmap.widthDots / 8);
    const xL = bytesPerRow & 0xff;
    const xH = (bytesPerRow >> 8) & 0xff;
    const yL = bitmap.heightDots & 0xff;
    const yH = (bitmap.heightDots >> 8) & 0xff;
    this.raw(GS, 0x76, 0x30, 0x00, xL, xH, yL, yH);
    this.bytes.push(...bitmap.data);
    return this;
  }

  build(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }

  get length(): number {
    return this.bytes.length;
  }
}

export type TextEncoderFn = (value: string) => number[];

export type RasterImage = {
  widthDots: number;
  heightDots: number;
  /** 1-bit packed, MSB first, one row after another. */
  data: number[];
};

/**
 * Encodes text for code page 850 (Latin-1 with Spanish accents). Characters
 * outside the table fall back to a close ASCII equivalent so a stray glyph can
 * never corrupt the rest of the ticket.
 */
export function encodeCodepage850(value: string): number[] {
  const out: number[] = [];
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === '\n') {
      out.push(LF);
      continue;
    }
    if (code < 0x80) {
      out.push(code);
      continue;
    }
    const mapped = CP850_HIGH[char];
    if (mapped !== undefined) {
      out.push(mapped);
      continue;
    }
    out.push(...asciiFallback(char));
  }
  return out;
}

/**
 * Encodes text as plain ASCII, stripping accents. A safer fallback for printers
 * whose code page we cannot determine: better to print "Linea" than
 * mangled bytes.
 */
export function encodeAscii(value: string): number[] {
  const out: number[] = [];
  for (const char of value) {
    if (char === '\n') {
      out.push(LF);
      continue;
    }
    const code = char.codePointAt(0)!;
    if (code < 0x80) {
      out.push(code);
    } else {
      out.push(...asciiFallback(char));
    }
  }
  return out;
}

/** CP850 mappings for the accented characters Spanish tickets actually use. */
const CP850_HIGH: Record<string, number> = {
  'á': 0xa0,
  'é': 0x82,
  'í': 0xa1,
  'ó': 0xa2,
  'ú': 0xa3,
  'Á': 0xb5,
  'É': 0x90,
  'Í': 0xd6,
  'Ó': 0xe0,
  'Ú': 0xe9,
  'ñ': 0xa4,
  'Ñ': 0xa5,
  'ü': 0x81,
  'Ü': 0x9a,
  '¡': 0xad,
  '¿': 0xa8,
  'º': 0xa7,
  'ª': 0xa6,
  '°': 0xf8,
  '·': 0xfa,
  '\u2013': 0x2d,
  '\u2014': 0x2d,
  '\u201c': 0x22,
  '\u201d': 0x22,
  '\u2019': 0x27,
};

const ASCII_FALLBACK: Record<string, string> = {
  'á': 'a',
  'é': 'e',
  'í': 'i',
  'ó': 'o',
  'ú': 'u',
  'Á': 'A',
  'É': 'E',
  'Í': 'I',
  'Ó': 'O',
  'Ú': 'U',
  'ñ': 'n',
  'Ñ': 'N',
  'ü': 'u',
  'Ü': 'U',
  '¡': '!',
  '¿': '?',
  'º': 'o',
  'ª': 'a',
  '°': 'o',
  '·': '-',
  '\u2013': '-',
  '\u2014': '-',
  '\u201c': '"',
  '\u201d': '"',
  '\u2019': "'",
};

function asciiFallback(char: string): number[] {
  const replacement = ASCII_FALLBACK[char] ?? '?';
  return [...replacement].map((c) => c.codePointAt(0)! & 0x7f);
}

/** Pads or truncates a string to an exact column count, for aligned columns. */
export function fitColumns(value: string, columns: number, align: 'left' | 'right' = 'left'): string {
  const flat = value.replace(/\n/g, ' ');
  if (flat.length >= columns) return flat.slice(0, columns);
  const padding = ' '.repeat(columns - flat.length);
  return align === 'left' ? flat + padding : padding + flat;
}

/** Lays out a two-column row (label left, value right) within the paper width. */
export function twoColumns(left: string, right: string, columns = PAPER_58MM_COLUMNS): string {
  const room = columns - right.length;
  if (room <= 0) return `${left}\n${right}`;
  const padded = left.length > room ? left.slice(0, Math.max(0, room - 1)) : left;
  return fitColumns(padded, room) + right;
}

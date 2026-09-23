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

/**
 * Lines to feed at the end of a job so the last printed line clears the tear
 * bar. The print head sits roughly 20 to 30mm above the bar, so a short feed
 * leaves the final lines printed but stuck inside the printer. Tuned on an
 * MP58C6: 4 to 12 lines left the last lines inside, 15 barely cleared the bar,
 * 18 leaves a comfortable margin.
 */
export const TEAR_OFF_FEED_LINES = 18;

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

  /**
   * Whether the next byte starts a new print line. Tracked so align() can
   * refuse to run mid-line: ESC/POS only applies alignment at the start of a
   * line, and strict printers ignore it anywhere else, so the change lands on
   * the following line instead.
   */
  private atLineStart = true;

  /** The alignment in effect, so helpers that change it can put it back. */
  private currentAlign: Align = 'left';

  /** Appends raw bytes. Values are taken modulo 256. */
  raw(...values: number[]): this {
    for (const value of values) this.bytes.push(value & 0xff);
    return this;
  }

  /** ESC @ : reset the printer to its power-on defaults. Start every job. */
  init(): this {
    this.atLineStart = true;
    this.currentAlign = 'left';
    return this.raw(ESC, 0x40);
  }

  /** ESC t n : select the character code table (affects accented characters). */
  codepage(page: Codepage): this {
    return this.raw(ESC, 0x74, page);
  }

  /**
   * ESC a n : alignment for the lines that follow. Call it at the start of a
   * line (before any text on it); mid-line it throws, because printers either
   * ignore it there or apply it to the next line.
   */
  align(align: Align): this {
    if (!this.atLineStart) {
      throw new Error('align() must be called at the start of a line: finish the current line with line() first');
    }
    this.currentAlign = align;
    return this.raw(ESC, 0x61, ALIGN_CODE[align]);
  }

  /** ESC E n : emphasized (bold) mode. */
  bold(on: boolean): this {
    return this.raw(ESC, 0x45, on ? 1 : 0);
  }

  /**
   * GS ! n : character size multiplier, 1 to 8 each (clamped). n packs
   * width/height each minus one, so size 2 (double width and height) is 0x11.
   */
  size(widthMultiplier = 1, heightMultiplier = 1): this {
    const w = clampInt(widthMultiplier, 1, 8) - 1;
    const h = clampInt(heightMultiplier, 1, 8) - 1;
    return this.raw(GS, 0x21, (w << 4) | h);
  }

  /** ESC d n : feed n blank lines. The command takes at most 255, so larger feeds are split. */
  feed(lines = 1): this {
    let remaining = clampInt(lines, 0, Number.MAX_SAFE_INTEGER);
    while (remaining > 0) {
      const step = Math.min(remaining, 255);
      this.raw(ESC, 0x64, step);
      remaining -= step;
    }
    if (lines > 0) this.atLineStart = true;
    return this;
  }

  /**
   * Appends text wrapped to the paper width, one line per row. Use it for
   * anything that might be longer than a line: the printer hard-wraps on its
   * own, mid-word, and throws the layout off by a line.
   */
  wrapped(value: string, options: WrapOptions = {}, encoding?: TextEncoderFn): this {
    for (const row of wrap(value, options)) {
      this.line(row, encoding);
    }
    return this;
  }

  /** End a job with this: feeds far enough that every printed line can be torn off and read. */
  feedToTear(lines = TEAR_OFF_FEED_LINES): this {
    return this.feed(lines);
  }

  /** Encodes and appends text, converting line breaks to ESC/POS line feeds. */
  text(value: string, encoding: TextEncoderFn = encodeCodepage850): this {
    const bytes = encoding(value);
    for (const byte of bytes) this.bytes.push(byte & 0xff);
    if (bytes.length > 0) this.atLineStart = bytes[bytes.length - 1] === LF;
    return this;
  }

  /** Appends a text line followed by a line feed. */
  line(value = '', encoding?: TextEncoderFn): this {
    this.text(value, encoding);
    this.atLineStart = true;
    return this.raw(LF);
  }

  /**
   * A visible tear line, for printers without an auto-cutter (the MP58C6 has
   * none): print a rule and tear the paper along it.
   */
  tearLine(char = '-', columns = PAPER_58MM_COLUMNS): this {
    return this.line(char.repeat(columns));
  }

  /**
   * Dashed rule ("- - -"), a lighter-looking tear line.
   *
   * On an even column count an alternating pattern can't be symmetric: 32
   * columns would start with a dash and end with a space, so the rule sits
   * half a character left of centre and centred text above or below it looks
   * shifted right. So it prints one column short (starting and ending with a
   * dash) and centred, which the printer does by the dot, leaving an equal
   * half-character gap on each side. The previous alignment is restored.
   */
  dashedRule(columns = PAPER_58MM_COLUMNS): this {
    const width = columns % 2 === 0 ? columns - 1 : columns;
    let rule = '';
    while (rule.length < width) rule += '- ';
    rule = rule.slice(0, width);
    if (width === columns || this.currentAlign === 'center') return this.line(rule);
    const previous = this.currentAlign;
    return this.align('center').line(rule).align(previous);
  }

  /**
   * GS v 0 : raster bit image. `bitmap` is already 1-bit packed, row-major,
   * MSB first, with each row padded to whole bytes. Call it at the start of a
   * line; the paper is at the start of a line again afterwards.
   *
   * The image goes out as strips of at most `maxRowsPerStrip` rows (255 by
   * default), each with its own header. Some printers read only the low byte
   * of the height, so a 288 row image would print as 32 rows followed by the
   * remaining pixel data as garbage text. Lower it for printers with a very
   * small buffer.
   *
   * Throws if `data` isn't exactly rows × bytes-per-row long: the printer
   * would otherwise keep reading the following text as image data (or stop
   * short and print the rest of the image as garbage), ruining the receipt.
   */
  raster(bitmap: RasterImage, { maxRowsPerStrip = 255 }: { maxRowsPerStrip?: number } = {}): this {
    if (bitmap.widthDots <= 0 || bitmap.heightDots <= 0) return this;
    const bytesPerRow = Math.ceil(bitmap.widthDots / 8);
    const expected = bytesPerRow * bitmap.heightDots;
    if (bitmap.data.length !== expected) {
      throw new RangeError(
        `Raster data is ${bitmap.data.length} bytes, expected ${expected} (${bytesPerRow} bytes x ${bitmap.heightDots} rows)`
      );
    }
    if (bytesPerRow > 0xffff) {
      throw new RangeError('Raster image is too wide for GS v 0');
    }
    const stripRows = clampInt(maxRowsPerStrip, 1, 255);
    for (let top = 0; top < bitmap.heightDots; top += stripRows) {
      const rows = Math.min(stripRows, bitmap.heightDots - top);
      this.raw(GS, 0x76, 0x30, 0x00, bytesPerRow & 0xff, bytesPerRow >> 8, rows, 0);
      // A loop, not push(...data): spreading a large image can overflow the
      // call stack on Hermes.
      const end = (top + rows) * bytesPerRow;
      for (let i = top * bytesPerRow; i < end; i++) this.bytes.push(bitmap.data[i] & 0xff);
    }
    this.atLineStart = true;
    return this;
  }

  build(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }

  get length(): number {
    return this.bytes.length;
  }
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export type TextEncoderFn = (value: string) => number[];

export type RasterImage = {
  widthDots: number;
  heightDots: number;
  /** 1-bit packed, MSB first, one row after another. */
  data: number[];
};

/**
 * Encodes text for code page 850 (Western European, with Spanish, French,
 * Portuguese and German accents). Characters outside the table fall back to a
 * close ASCII equivalent, so a stray glyph can never corrupt the rest of the
 * receipt.
 */
export function encodeCodepage850(value: string): number[] {
  const out: number[] = [];
  for (const char of normalizeText(value)) {
    const code = char.codePointAt(0)!;
    if (code < 0x80) {
      out.push(code);
      continue;
    }
    const entry = CHARACTERS[char];
    if (entry && entry[0] !== undefined) {
      out.push(entry[0]);
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
  for (const char of normalizeText(value)) {
    const code = char.codePointAt(0)!;
    out.push(...(code < 0x80 ? [code] : asciiFallback(char)));
  }
  return out;
}

/**
 * Composes accents typed as a letter plus a combining mark (so "e" + U+0301
 * becomes "é" and maps to one byte), drops carriage returns, which some
 * printers treat as "return to the start of the line", and turns tabs into a
 * space.
 */
function normalizeText(value: string): string {
  let text = value;
  try {
    text = text.normalize('NFC');
  } catch {
    // An engine without normalize support: leave the text as is.
  }
  return text.replace(/\r/g, '').replace(/\t/g, ' ');
}

/** Combining marks left over after NFC (no precomposed form): print nothing for them. */
const COMBINING_MARK = /^[\u0300-\u036f]$/;

/**
 * Each non-ASCII character we know: its CP850 byte (undefined when CP850 has
 * none) and its closest ASCII text.
 */
const CHARACTERS: Record<string, [number | undefined, string]> = {
  'Ç': [0x80, 'C'], 'ü': [0x81, 'u'], 'é': [0x82, 'e'], 'â': [0x83, 'a'], 'ä': [0x84, 'a'],
  'à': [0x85, 'a'], 'å': [0x86, 'a'], 'ç': [0x87, 'c'], 'ê': [0x88, 'e'], 'ë': [0x89, 'e'],
  'è': [0x8a, 'e'], 'ï': [0x8b, 'i'], 'î': [0x8c, 'i'], 'ì': [0x8d, 'i'], 'Ä': [0x8e, 'A'],
  'Å': [0x8f, 'A'], 'É': [0x90, 'E'], 'æ': [0x91, 'ae'], 'Æ': [0x92, 'AE'], 'ô': [0x93, 'o'],
  'ö': [0x94, 'o'], 'ò': [0x95, 'o'], 'û': [0x96, 'u'], 'ù': [0x97, 'u'], 'ÿ': [0x98, 'y'],
  'Ö': [0x99, 'O'], 'Ü': [0x9a, 'U'], 'ø': [0x9b, 'o'], '£': [0x9c, 'GBP'], 'Ø': [0x9d, 'O'],
  '×': [0x9e, 'x'], 'ƒ': [0x9f, 'f'], 'á': [0xa0, 'a'], 'í': [0xa1, 'i'], 'ó': [0xa2, 'o'],
  'ú': [0xa3, 'u'], 'ñ': [0xa4, 'n'], 'Ñ': [0xa5, 'N'], 'ª': [0xa6, 'a'], 'º': [0xa7, 'o'],
  '¿': [0xa8, '?'], '®': [0xa9, '(R)'], '¬': [0xaa, '-'], '½': [0xab, '1/2'], '¼': [0xac, '1/4'],
  '¡': [0xad, '!'], '«': [0xae, '<<'], '»': [0xaf, '>>'], 'Á': [0xb5, 'A'], 'Â': [0xb6, 'A'],
  'À': [0xb7, 'A'], '©': [0xb8, '(C)'], '¢': [0xbd, 'c'], '¥': [0xbe, 'JPY'], 'ã': [0xc6, 'a'],
  'Ã': [0xc7, 'A'], '¤': [0xcf, '?'], 'ð': [0xd0, 'd'], 'Ð': [0xd1, 'D'], 'Ê': [0xd2, 'E'],
  'Ë': [0xd3, 'E'], 'È': [0xd4, 'E'], 'Í': [0xd6, 'I'], 'Î': [0xd7, 'I'], 'Ï': [0xd8, 'I'],
  'Ì': [0xde, 'I'], 'Ó': [0xe0, 'O'], 'ß': [0xe1, 'ss'], 'Ô': [0xe2, 'O'], 'Ò': [0xe3, 'O'],
  'õ': [0xe4, 'o'], 'Õ': [0xe5, 'O'], 'µ': [0xe6, 'u'], 'þ': [0xe7, 'th'], 'Þ': [0xe8, 'TH'],
  'Ú': [0xe9, 'U'], 'Û': [0xea, 'U'], 'Ù': [0xeb, 'U'], 'ý': [0xec, 'y'], 'Ý': [0xed, 'Y'],
  '¯': [0xee, '-'], '´': [0xef, "'"], '±': [0xf1, '+/-'], '¾': [0xf3, '3/4'], '¶': [0xf4, 'P'],
  '§': [0xf5, 'S'], '÷': [0xf6, '/'], '¸': [0xf7, ','], '°': [0xf8, 'o'], '¨': [0xf9, '"'],
  '·': [0xfa, '-'], '¹': [0xfb, '1'], '³': [0xfc, '3'], '²': [0xfd, '2'],
  '\u00a0': [0xff, ' '], // no-break space
  // Other spaces. iOS's toLocaleString() puts U+202F before "AM"/"PM".
  '\u2002': [0x20, ' '], '\u2003': [0x20, ' '], '\u2004': [0x20, ' '], '\u2005': [0x20, ' '],
  '\u2006': [0x20, ' '], '\u2007': [0x20, ' '], '\u2008': [0x20, ' '], '\u2009': [0x20, ' '],
  '\u200a': [0x20, ' '], '\u202f': [0x20, ' '], '\u205f': [0x20, ' '],
  // Invisible characters: print nothing.
  '\u200b': [undefined, ''], '\u200c': [undefined, ''], '\u200d': [undefined, ''], '\ufeff': [undefined, ''],
  '\u2212': [0x2d, '-'], // minus sign
  // Punctuation phones and word processors insert, with no CP850 byte.
  '\u2013': [0x2d, '-'], '\u2014': [0x2d, '-'], '\u2018': [0x27, "'"], '\u2019': [0x27, "'"],
  '\u201c': [0x22, '"'], '\u201d': [0x22, '"'], '\u2026': [undefined, '...'], '\u2022': [undefined, '*'],
  '€': [undefined, 'EUR'],
};

function asciiFallback(char: string): number[] {
  if (COMBINING_MARK.test(char)) return [];
  const replacement = CHARACTERS[char]?.[1] ?? '?';
  return [...replacement].map((c) => c.codePointAt(0)! & 0x7f);
}

export type WrapOptions = {
  /** Characters per line. Defaults to 58mm paper's 32. */
  columns?: number;
  /** Prefix for the first line; later lines get the same width in spaces, so they align under it. */
  indent?: string;
};

/**
 * Splits text into lines that fit the paper, breaking at spaces. A word longer
 * than a whole line is cut, since there is nowhere else for it to go. Line
 * breaks in the input are kept.
 */
export function wrap(value: string, { columns = PAPER_58MM_COLUMNS, indent = '' }: WrapOptions = {}): string[] {
  const room = Math.max(1, columns - indent.length);
  const hanging = ' '.repeat(indent.length);
  const rows: string[] = [];

  for (const paragraph of value.split('\n')) {
    let current = '';
    for (const word of paragraph.split(/ +/).filter(Boolean)) {
      let rest = word;
      while (rest.length > 0) {
        const candidate = current ? `${current} ${rest}` : rest;
        if (candidate.length <= room) {
          current = candidate;
          rest = '';
        } else if (current) {
          rows.push(current);
          current = '';
        } else {
          rows.push(rest.slice(0, room));
          rest = rest.slice(room);
        }
      }
    }
    rows.push(current);
  }

  return rows.map((row, i) => (i === 0 ? indent : hanging) + row);
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

import type { RasterImage } from '@ricka7x/expo-thermal-printer/escpos';

/**
 * A ring, drawn in code so the examples need no image file. A real app would
 * convert its logo (a PNG) to this 1-bit format once, ahead of time, and keep
 * the result as a constant: a row of `widthDots / 8` bytes per pixel row,
 * most significant bit first, 1 = black.
 */
export function ringLogo(sizeDots = 96): RasterImage {
  const bytesPerRow = Math.ceil(sizeDots / 8);
  const data = new Array<number>(bytesPerRow * sizeDots).fill(0);
  const centre = (sizeDots - 1) / 2;
  const outer = sizeDots / 2;
  const inner = outer * 0.6;
  for (let y = 0; y < sizeDots; y++) {
    for (let x = 0; x < sizeDots; x++) {
      const distance = Math.hypot(x - centre, y - centre);
      if (distance <= outer && distance >= inner) {
        data[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return { widthDots: sizeDots, heightDots: sizeDots, data };
}

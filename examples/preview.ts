/**
 * Prints every example template as ASCII, or only the ones named:
 *
 *   npm run preview
 *   npm run preview -- kitchen-order queue-ticket
 */
import { previewReceipt } from 'expo-thermal-printer/escpos';

import { samples } from './samples';

const wanted = process.argv.slice(2);
const chosen = wanted.length ? samples.filter((sample) => wanted.includes(sample.name)) : samples;
if (chosen.length === 0) {
  console.error(`No example named ${wanted.join(', ')}. Available: ${samples.map((s) => s.name).join(', ')}`);
  process.exit(1);
}
for (const sample of chosen) {
  console.log(`\n${sample.name}: ${sample.description}\n`);
  console.log(previewReceipt(sample.build(), { columns: sample.columns, widthDots: sample.columns === 48 ? 576 : 384 }));
}

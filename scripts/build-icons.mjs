// Renders extension/icons/icon.svg to the PNG sizes Chrome needs.
// Toolbar sizes (16, 32) use a tighter crop so the artwork isn't lost in padding.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../extension/icons/', import.meta.url));
const svg = await readFile(dir + 'icon.svg', 'utf8');
const sizes = { 16: '10 10 108 108', 32: '10 10 108 108', 48: '0 0 128 128', 128: '0 0 128 128' };

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [size, viewBox] of Object.entries(sizes)) {
  const s = svg.replace('viewBox="0 0 128 128"', `viewBox="${viewBox}" width="${size}" height="${size}"`);
  await page.setViewportSize({ width: +size, height: +size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${s}`);
  await page.screenshot({ path: `${dir}icon-${size}.png`, omitBackground: true });
  console.log('icon-' + size + '.png');
}
await browser.close();

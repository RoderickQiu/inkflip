// Adversarial check for photo safety: the test photos and products made grey, sepia, foggy or
// high-key, then cut out on transparent backgrounds or set on white, 240 variants in all. None
// should flip; the only ones that do are a white iPhone washed out until it is almost flat.
//
//   node research/cutouts.mjs     (needs `npm run test:real` to have downloaded the images)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { root } from '../test/lib.mjs';
const IMG = path.join(root, 'test/.cache/images');
const photos = (await readdir(IMG)).filter((f) => /^(photo_|prod_)/.test(f));
const server = createServer(async (req, res) => {
  const f = req.url === '/classifier.js' ? path.join(root, 'extension/classifier.js') : path.join(IMG, path.basename(req.url));
  try { res.end(await readFile(f)); } catch { res.statusCode = 404; res.end(); }
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(base + '/none').catch(() => {});
await page.addScriptTag({ url: base + '/classifier.js' });
let flips = 0, n = 0;
for (const f of photos) {
  const out = await page.evaluate(async (src) => {
    const im = new Image(); im.src = src; await im.decode();
    const C = globalThis.InkflipClassifier, res = [];
    const W = 400, H = Math.round(400 * im.naturalHeight / im.naturalWidth);
    for (const look of ['grey', 'sepia', 'fog', 'greyfog', 'highkey']) for (const mask of ['ellipse', 'blob', 'square', 'ellipse-white', 'blob-white', 'square-white']) {
      const cv = new OffscreenCanvas(W, H), g = cv.getContext('2d');
      g.filter = { grey: 'grayscale(1)', sepia: 'sepia(1)', fog: 'contrast(0.35) brightness(1.4)', greyfog: 'grayscale(1) contrast(0.4) brightness(1.35)', highkey: 'grayscale(1) brightness(1.6) contrast(0.8)' }[look];
      g.drawImage(im, 0, 0, W, H); g.filter = 'none';
      g.globalCompositeOperation = 'destination-in'; g.beginPath();
      const shape = mask.replace('-white', '');
      if (shape === 'ellipse') g.ellipse(W / 2, H / 2, W * 0.35, H * 0.4, 0, 0, 7);
      else if (shape === 'square') g.rect(W * 0.2, H * 0.15, W * 0.6, H * 0.7);
      else { for (let a = 0; a < 6.3; a += 0.3) { const r = 0.3 + 0.12 * Math.sin(a * 3); g.lineTo(W / 2 + Math.cos(a) * W * r, H / 2 + Math.sin(a) * H * r); } }
      g.fill();
      if (mask.endsWith('-white')) { g.globalCompositeOperation = 'destination-over'; g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); }
      const px = C.pixels(cv, W, H, false); const c = C.classify(px.data, px.w, px.h);
      res.push([look, mask, c.verdict, "fg" + c.signals.fg90, "t" + c.signals.tone.toFixed(2), "D" + c.signals.dark.toFixed(2), "L" + c.signals.light.toFixed(2), "grey" + c.signals.grey.toFixed(2), "T" + c.signals.transp.toFixed(2), "C" + c.signals.color.toFixed(2)]);
    }
    return res;
  }, base + '/' + f);
  for (const r of out) { n++; if (r[2] === 'flip' || r[2] === 'logo') { flips++; console.log('FLIP', f, r.join(' ')); } }
}
console.log(`${n} cut-out variants of ${photos.length} photos, ${flips} flipped or brightened`);
await browser.close(); server.close();

// Runs the classifier inside real Chromium on the labelled real-world images listed in
// research/test-images.tsv (downloaded on first run into test/.cache, never committed).
// Exit code 1 if any verdict differs from the label.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const cacheDir = path.join(root, 'test/.cache/images');
await mkdir(cacheDir, { recursive: true });

const rows = (await readFile(path.join(root, 'research/test-images.tsv'), 'utf8'))
  .trim().split('\n').slice(1).map((l) => {
    const [file, expected, url] = l.split('\t');
    return { file, expected: expected.split('|').map((v) => v.toLowerCase()), url };
  });

for (const r of rows) {
  const p = path.join(cacheDir, r.file);
  try { await access(p); } catch {
    const res = await fetch(r.url, { headers: { 'User-Agent': 'inkflip-tests/0.1' } });
    if (!res.ok) throw new Error(`download failed: ${r.url} (${res.status})`);
    await writeFile(p, Buffer.from(await res.arrayBuffer()));
  }
}

// Same-origin server so the canvas isn't tainted.
const server = createServer(async (req, res) => {
  const name = decodeURIComponent(req.url.split('?')[0]);
  const file = name === '/classifier.js' ? path.join(root, 'extension/classifier.js') : path.join(cacheDir, path.basename(name));
  try {
    res.end(await readFile(file));
  } catch {
    res.statusCode = 404;
    res.end();
  }
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(base + '/none');
await page.addScriptTag({ url: base + '/classifier.js' });
const results = await page.evaluate(async (files) => {
  const C = window.InkflipClassifier;
  const out = {};
  for (const f of files) {
    const img = new Image();
    img.src = '/' + f;
    await img.decode();
    // Mirrors sampleElement() in content.js.
    const [tw, th] = C.sampleSize(img.naturalWidth, img.naturalHeight);
    const cv = new OffscreenCanvas(tw, th);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, tw, th);
    out[f] = C.classify(ctx.getImageData(0, 0, tw, th).data, tw, th);
  }
  return out;
}, rows.map((r) => r.file));
await browser.close();
server.close();

let ok = 0;
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('image', 22), pad('verdict', 8), pad('expected', 10), 'tone  fg90  light  color');
for (const r of rows) {
  const { verdict, signals: s } = results[r.file];
  const hit = r.expected.includes(verdict);
  ok += hit;
  console.log(pad(r.file, 22), pad(verdict, 8), pad(r.expected.join('|'), 10),
    s.tone.toFixed(2), String(s.fg90).padStart(5), s.light.toFixed(2).padStart(6), s.color.toFixed(2).padStart(6),
    hit ? '' : '  <-- wrong');
}
console.log(`\n${ok}/${rows.length} as labelled`);
process.exit(ok === rows.length ? 0 : 1);

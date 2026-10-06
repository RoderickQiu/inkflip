// Harvests real images from a field-test run for labelling.
//
//   node research/harvest.mjs            download + classify + review sheets
//
// Reads screenshots/field/results.json, downloads up to 16 meaningful images per page
// (rendered at least 64×48, changed ones first) into research/.cache/field/, classifies
// each one in Chromium with the current extension/classifier.js, and renders review sheets
// (research/.cache/field/sheet-*.png): every image on a checkerboard so transparency shows,
// captioned with its index, page and current verdict. Labels then go in research/field-labels.tsv.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { root, plainUserAgent } from '../test/lib.mjs';

const OUT = path.join(root, 'research/.cache/field');
await mkdir(OUT, { recursive: true });
const results = JSON.parse(await readFile(path.join(root, 'screenshots/field/results.json'), 'utf8'));
const ua = await plainUserAgent();
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/avif': 'avif' };

const picks = [];
const seenSrc = new Set();
for (const r of results) {
  const imgs = (r.images || []).filter((m) => m.w >= 64 && m.h >= 48 && /^https?:/.test(m.src) && !seenSrc.has(m.src));
  imgs.sort((a, b) => (b.v && b.v !== 'none') - (a.v && a.v !== 'none') || b.w * b.h - a.w * a.h);
  for (const m of imgs.slice(0, 16)) {
    seenSrc.add(m.src);
    picks.push({ page: r.id, pageUrl: r.url, src: m.src, w: m.w, h: m.h, fieldVerdict: m.v });
  }
}

// Download (with the page as Referer: some hosts refuse hotlinks).
let n = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (n < picks.length) {
    const p = picks[n++];
    const base = createHash('sha1').update(p.src).digest('hex').slice(0, 12);
    try {
      for (const ext of Object.values(EXT)) {
        if (await access(path.join(OUT, `${base}.${ext}`)).then(() => true, () => false)) { p.file = `${base}.${ext}`; break; }
      }
      if (!p.file) {
        const res = await fetch(p.src, { headers: { 'User-Agent': ua, Referer: p.pageUrl } });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const type = (res.headers.get('content-type') || '').split(';')[0].trim();
        const ext = EXT[type] || (p.src.match(/\.(png|jpe?g|gif|webp|svg|avif)/i) || [])[1] || 'img';
        p.file = `${base}.${ext}`;
        await writeFile(path.join(OUT, p.file), Buffer.from(await res.arrayBuffer()));
      }
    } catch (e) {
      p.error = e.message;
    }
  }
}));
const ok = picks.filter((p) => p.file);
console.log(`${ok.length}/${picks.length} images downloaded`);

// Classify in Chromium, same sampling as the content script.
const server = createServer(async (req, res) => {
  const name = decodeURIComponent(req.url.split('?')[0]);
  const file = name === '/classifier.js' ? path.join(root, 'extension/classifier.js') : path.join(OUT, path.basename(name));
  try {
    if (file.endsWith('.svg')) res.setHeader('Content-Type', 'image/svg+xml');
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
const classified = await page.evaluate(async (files) => {
  const C = window.InkflipClassifier;
  const out = {};
  for (const f of files) {
    try {
      const img = new Image();
      img.src = '/' + f;
      await img.decode();
      const w = img.naturalWidth || 300, h = img.naturalHeight || 150;
      const px = C.pixels(img, w, h, /\.svg$/i.test(img.src));
      out[f] = C.classify(px.data, px.w, px.h);
    } catch (e) {
      out[f] = { error: String(e) };
    }
  }
  return out;
}, ok.map((p) => p.file));
for (const p of ok) Object.assign(p, classified[p.file]);
ok.forEach((p, i) => { p.idx = i; });
await writeFile(path.join(OUT, 'index.json'), JSON.stringify(ok, null, 1));

// Review sheets: 6 × 4 images each.
const per = 24;
for (let s = 0; s * per < ok.length; s++) {
  const cells = ok.slice(s * per, (s + 1) * per).map((p) => `
    <div class="cell"><div class="img"><img src="${base}/${p.file}"></div>
    <div class="cap"><b>#${p.idx}</b> ${p.page} · <i>${p.verdict || p.error || '?'}</i></div></div>`).join('');
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.setContent(`<style>
    body{margin:0;padding:10px;background:#181a1b;font:13px/1.3 system-ui;color:#ddd}
    .grid{display:grid;grid-template-columns:repeat(6,1fr);gap:10px}
    .img{height:200px;display:flex;align-items:center;justify-content:center;
      background:repeating-conic-gradient(#3a3d42 0 25%,#2a2c30 0 50%) 0 0/16px 16px;border-radius:4px}
    .img img{max-width:100%;max-height:200px} i{color:#f2b45a;font-style:normal}
  </style><div class="grid">${cells}</div>`, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, `sheet-${s}.png`), fullPage: true });
}
await browser.close();
server.close();
console.log(`${Math.ceil(ok.length / per)} review sheets in research/.cache/field/`);

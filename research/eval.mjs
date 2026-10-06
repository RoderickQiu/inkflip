// Scores extension/classifier.js against the labelled field images.
//
//   node research/eval.mjs [--show wrong|miss|soft|all]
//
// Needs research/harvest.mjs to have downloaded the images once. Labels come from
// research/field-labels.tsv: each image lists its acceptable verdicts. Errors, worst first:
//   wrong  flipped (or brightened) an image that must not be flipped: photos, white logos, heatmaps
//   miss   left alone an image that needs flipping
//   soft   dimmed an image that should have been flipped (tolerated: "when unsure, dim")
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { root } from '../test/lib.mjs';

const DIR = path.join(root, 'research/.cache/field');
const show = process.argv.includes('--show') ? process.argv[process.argv.indexOf('--show') + 1] : 'wrong,miss';
const files = new Map((await readdir(DIR)).map((f) => [f.split('.')[0], f]));
const rows = (await readFile(path.join(root, 'research/field-labels.tsv'), 'utf8')).trim().split('\n').slice(1)
  .map((l) => { const [src, page, pageUrl, acceptable] = l.split('\t'); return { src, page, pageUrl, ok: acceptable.split('|') }; })
  .map((r) => ({ ...r, file: files.get(createHash('sha1').update(r.src).digest('hex').slice(0, 12)) }))
  .filter((r) => r.file);

const server = createServer(async (req, res) => {
  const name = decodeURIComponent(req.url.split('?')[0]);
  const file = name === '/classifier.js' ? path.join(root, 'extension/classifier.js') : path.join(DIR, path.basename(name));
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
const out = await page.evaluate(async (files) => {
  const C = window.InkflipClassifier;
  const res = {};
  for (const f of files) {
    try {
      const img = new Image();
      img.src = '/' + f;
      await img.decode();
      const px = C.pixels(img, img.naturalWidth || 300, img.naturalHeight || 150, /\.svg$/i.test(img.src));
      res[f] = C.classify(px.data, px.w, px.h);
    } catch (e) {
      res[f] = null;
    }
  }
  return res;
}, rows.map((r) => r.file));
await browser.close();
server.close();

const kinds = { ok: [], wrong: [], miss: [], soft: [] };
for (const r of rows) {
  const c = out[r.file];
  if (!c) continue;
  r.verdict = c.verdict;
  r.signals = c.signals;
  const flipping = r.verdict === 'flip' || r.verdict === 'logo';
  if (r.ok.includes(r.verdict)) kinds.ok.push(r);
  else if (flipping) kinds.wrong.push(r);
  else if (r.verdict === 'dim' && r.ok.includes('flip')) kinds.soft.push(r);
  else kinds.miss.push(r);
}
await writeFile(path.join(DIR, 'eval.json'), JSON.stringify(rows, null, 1));

const fmt = (s) => `t${s.tone.toFixed(2)} fg${String(s.fg90).padStart(3)} L${s.light.toFixed(2)} D${s.dark.toFixed(2)} C${s.color.toFixed(2)} B${s.border.toFixed(2)} T${s.transp.toFixed(2)}` +
  Object.entries(s).filter(([k]) => !['tone', 'fg90', 'light', 'dark', 'color', 'border', 'transp'].includes(k)).map(([k, v]) => ` ${k}${typeof v === 'number' ? v.toFixed(2) : v}`).join('');
const total = rows.filter((r) => r.verdict).length;
console.log(`${total} images: ${kinds.ok.length} ok · ${kinds.wrong.length} wrong flips · ${kinds.miss.length} misses · ${kinds.soft.length} soft (dimmed, should flip)`);
for (const k of ['wrong', 'miss', 'soft']) {
  if (!show.includes(k) && show !== 'all') continue;
  if (!kinds[k].length) continue;
  console.log(`\n${k}:`);
  for (const r of kinds[k]) console.log(`  ${r.verdict.padEnd(5)} want ${r.ok.join('|').padEnd(16)} ${fmt(r.signals)}  ${r.page} ${r.src.split('?')[0].split('/').pop().slice(0, 40)}`);
}

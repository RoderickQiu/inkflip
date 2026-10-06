// Builds screenshots/field/report.html and screenshots/field/contact-sheet.png from the
// results and screenshots that test/field.mjs wrote. Optional reviewer notes per page come
// from screenshots/field/notes.json ({ "<id>": { "verdict": "good|issue|fixed|skip", "note": "...",
// "exclude": true } }); excluded pages are left out of the report and the contact sheet.
import { chromium } from 'playwright';
import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { root } from './lib.mjs';

const OUT = path.join(root, 'screenshots/field');
let notes = {};
try { notes = JSON.parse(await readFile(path.join(OUT, 'notes.json'), 'utf8')); } catch { /* none yet */ }
const results = JSON.parse(await readFile(path.join(OUT, 'results.json'), 'utf8'))
  .filter((r) => !(notes[r.id] && notes[r.id].exclude));
const exists = async (f) => access(path.join(OUT, f)).then(() => true, () => false);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const BADGE = { good: '#5fbf7f', issue: '#e5735f', fixed: '#f2b45a', skip: '#8a8f98' };

const sections = [];
for (const r of results) {
  const n = notes[r.id] || {};
  const c = r.counts || {};
  const flags = [];
  if (r.status && r.status !== 'ok') flags.push(r.status);
  if (r.flashes && Object.keys(r.flashes).length) flags.push('white flash: ' + Object.entries(r.flashes).map(([k, v]) => `${k} ×${v}`).join(', '));
  if (r.stuck && r.stuck.length) flags.push(`${r.stuck.length} image(s) stayed hidden`);
  if (r.errors && r.errors.length) flags.push(`${r.errors.length} extension error(s)`);
  if (!r.darkReader) flags.push('Dark Reader not active');
  const changed = (r.images || []).filter((m) => m.v && m.v !== 'none');
  const rows = changed.slice(0, 12).map((m) => {
    const s = m.signals;
    const sig = s ? `tone ${s.tone.toFixed(2)} · fg ${s.fg90} · light ${s.light.toFixed(2)} · colour ${s.color.toFixed(2)}` : '';
    const state = m.l !== null ? m.v : `${m.v} (not applied)`;
    return `<tr><td>${esc(state)}</td><td>${m.w}×${m.h}</td><td>${esc(sig)}</td><td class="src">${esc(m.src.split('?')[0].split('/').pop().slice(0, 60))}</td></tr>`;
  }).join('');
  const shots = [];
  for (const kind of ['before', 'after', 'badges']) {
    if (await exists(`${r.id}-${kind}.jpg`)) shots.push(`<figure><a href="${r.id}-${kind}.jpg"><img src="${r.id}-${kind}.jpg" loading="lazy"></a><figcaption>${kind === 'before' ? 'Dark Reader alone' : kind === 'after' ? 'Dark Reader + Inkflip' : 'Verdict badges'}</figcaption></figure>`);
  }
  sections.push(`<section id="${r.id}">
    <h2>${esc(r.id)} ${n.verdict ? `<span class="pill" style="background:${BADGE[n.verdict]}">${esc(n.verdict)}</span>` : ''}</h2>
    <p class="meta">${esc(r.category)} · <a href="${esc(r.url)}">${esc(r.url)}</a><br>Expected: ${esc(r.expect)}</p>
    <p class="counts">flip <b>${c.flip ?? '–'}</b> · logo <b>${c.logo ?? '–'}</b> · dim <b>${c.dim ?? '–'}</b> · untouched <b>${c.none ?? '–'}</b> · not applied <b>${c.standby ?? '–'}</b> · unchecked <b>${c.unchecked ?? '–'}</b></p>
    ${flags.length ? `<p class="flags">${flags.map(esc).join(' · ')}</p>` : ''}
    ${n.note ? `<p class="note">${esc(n.note)}</p>` : ''}
    <div class="shots">${shots.join('')}</div>
    ${rows ? `<details><summary>${changed.length} changed image(s)</summary><table>${rows}</table></details>` : ''}
  </section>`);
}

const summary = { pages: results.length, flip: 0, logo: 0, dim: 0, flashes: 0, stuck: 0, errors: 0 };
for (const r of results) {
  for (const k of ['flip', 'logo', 'dim']) summary[k] += (r.counts || {})[k] || 0;
  summary.flashes += r.flashes && Object.keys(r.flashes).length ? 1 : 0;
  summary.stuck += (r.stuck || []).length;
  summary.errors += (r.errors || []).length;
}

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Inkflip field test</title><style>
body{margin:0;padding:32px 40px;background:#121316;color:#e8e6e3;font:14px/1.5 -apple-system,system-ui,sans-serif}
h1{margin:0 0 4px;font-size:24px} .lead{color:#9da1a8;margin:0 0 24px}
section{border-top:1px solid #2a2e34;padding:22px 0}
h2{font-size:17px;margin:0 0 4px} .meta{color:#9da1a8;margin:0 0 6px} a{color:#8fb8ff}
.counts b{color:#f2b45a} .flags{color:#e5735f;margin:4px 0} .note{background:#1c1e22;border-left:3px solid #f2b45a;padding:8px 12px;margin:8px 0}
.pill{display:inline-block;padding:0 8px;border-radius:9px;color:#111;font-size:12px;vertical-align:2px}
.shots{display:flex;gap:12px;margin-top:10px} figure{margin:0;flex:1} figure img{width:100%;border-radius:8px;border:1px solid #2a2e34}
figcaption{color:#9da1a8;font-size:12px;margin-top:4px} table{border-collapse:collapse;margin-top:6px;font-size:12.5px}
td{padding:2px 10px 2px 0;color:#c9c6c0} td.src{color:#8a8f98} summary{cursor:pointer;color:#9da1a8;margin-top:8px}
nav a{margin-right:10px}
</style></head><body>
<h1>Inkflip field test</h1>
<p class="lead">${summary.pages} pages, Dark Reader (Dynamic) + Inkflip, headless Chromium 1440×900.
Flipped ${summary.flip}, brightened ${summary.logo}, dimmed ${summary.dim}. Pages with a white flash: ${summary.flashes}. Images left hidden: ${summary.stuck}. Extension errors: ${summary.errors}.</p>
<nav>${results.map((r) => `<a href="#${r.id}">${esc(r.id)}</a>`).join('')}</nav>
${sections.join('\n')}
</body></html>`;
await writeFile(path.join(OUT, 'report.html'), html);
console.log('screenshots/field/report.html');

// Contact sheet: before | after thumbnails per page, with captions.
const cells = [];
for (const r of results) {
  if (!(await exists(`${r.id}-after.jpg`))) continue;
  const n = notes[r.id] || {};
  const pair = (kind) => `file://${path.join(OUT, `${r.id}-${kind}.jpg`)}`;
  cells.push(`<div class="cell"><div class="cap"><b>${esc(r.id)}</b>${n.verdict ? ` <span class="pill" style="background:${BADGE[n.verdict]}">${esc(n.verdict)}</span>` : ''}<span>${esc(r.category)} · flip ${r.counts?.flip ?? 0} · logo ${r.counts?.logo ?? 0} · dim ${r.counts?.dim ?? 0}</span></div>
    <div class="pair"><img src="${pair('before')}"><img src="${pair('after')}"></div></div>`);
}
const sheet = `<!doctype html><html><head><style>
body{margin:0;padding:24px;background:#121316;color:#e8e6e3;font:13px/1.4 -apple-system,system-ui,sans-serif;width:1872px}
h1{font-size:20px;margin:0 0 4px} p{color:#9da1a8;margin:0 0 16px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.cap{display:flex;gap:8px;align-items:baseline;margin-bottom:5px} .cap span{color:#9da1a8} .pill{padding:0 7px;border-radius:8px;color:#111;font-size:11px}
.pair{display:flex;gap:4px} .pair img{width:50%;border-radius:5px;border:1px solid #2a2e34}
</style></head><body><h1>Inkflip field test — contact sheet</h1><p>Each pair: Dark Reader alone (left) · Dark Reader + Inkflip (right)</p>
<div class="grid">${cells.join('')}</div></body></html>`;
const sheetPath = path.join(OUT, '.contact-sheet.html');
await writeFile(sheetPath, sheet);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1000 } });
await page.goto('file://' + sheetPath, { waitUntil: 'load' });
await page.screenshot({ path: path.join(OUT, 'contact-sheet.png'), fullPage: true });
await browser.close();
console.log('screenshots/field/contact-sheet.png');

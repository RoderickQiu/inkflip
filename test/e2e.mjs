// End-to-end test: loads the real extension into Playwright's Chromium and checks it on a
// local fixture page (same-origin, cross-origin and SVG images), then again next to
// Dark Reader. `--live` adds LeetCode problem 973. `--shots` writes the README images.
//
//   node test/e2e.mjs [--live] [--shots] [--headed]
//
// Runs headless by default (no windows, no focus stealing). A normal Chrome user agent
// gets LeetCode past Cloudflare's headless check.
//
// Needs test/real-images.mjs to have run once (it downloads the images) and, for the
// Dark Reader part, its MV3 build unpacked in test/.cache/darkreader.
import { createServer } from 'node:http';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { root, EXT, DR, launch, settings, flashes, waitFor } from './lib.mjs';

const IMAGES = path.join(root, 'test/.cache/images');
const SHOTS = path.join(root, 'docs/images');
const argv = new Set(process.argv.slice(2));

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures++;
}

// ------------------------------------------------------------------ fixture servers

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200">
<rect width="300" height="200" fill="#fff"/><path d="M20 180H280M20 180V20" stroke="#000" stroke-width="2"/>
<polyline points="20,160 80,100 140,130 200,60 280,40" stroke="#000" stroke-width="3" fill="none"/>
<circle cx="200" cy="60" r="5" fill="none" stroke="#000" stroke-width="2"/></svg>`;

function fixture(theme, other) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Inkflip fixture</title><style>
  body{margin:0;padding:32px 40px;font:15px/1.5 system-ui,sans-serif}
  body.dark{background:#181a1b;color:#e8e6e3} body.light{background:#fff;color:#222}
  h1{font-size:20px;margin:0 0 4px} p{margin:0 0 18px;opacity:.7}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:22px 18px;max-width:1240px}
  figure{margin:0} figcaption{font-size:12.5px;opacity:.7;margin-top:6px}
  img{display:block;width:100%;height:170px;object-fit:contain}
  </style></head><body class="${theme}">
  <h1>Inkflip test page</h1><p>Same-origin, cross-origin and SVG images on a ${theme} background.</p>
  <div class="grid">
  <figure><img id="same-diagram" src="/lc_closestplane.jpg"><figcaption>Diagram (JPEG, same origin)</figcaption></figure>
  <figure><img id="x-diagram" src="${other}/lc_tree.jpg"><figcaption>Diagram (cross-origin)</figcaption></figure>
  <figure><img id="x-svg" src="${other}/diagram.svg"><figcaption>Diagram (SVG, cross-origin)</figcaption></figure>
  <figure><img id="chart" src="/mpl_simpleplot.png"><figcaption>matplotlib chart</figcaption></figure>
  <figure><img id="logo" src="/logo_github.png"><figcaption>Black logo, transparent PNG</figcaption></figure>
  <figure><img id="product" src="${other}/prod_nikon.jpg"><figcaption>Product photo on white</figcaption></figure>
  <figure><img id="list" src="/lc_merge.jpg"><figcaption>Coloured diagram</figcaption></figure>
  <figure><img id="photo" src="/photo_b.jpg"><figcaption>Ordinary photo</figcaption></figure>
  </div>
  <p style="margin-top:18px">Avatar-sized photo on white: <img id="avatar" src="${other}/prod_fly.jpg" style="display:inline-block;width:32px;height:32px;vertical-align:middle;object-fit:cover"></p>
  <h1 style="margin-top:28px">Panel painted by a sibling layer</h1>
  <div style="position:relative;width:420px;padding:16px">
    <div style="position:absolute;inset:0;background:#2a2d31;border-radius:10px"></div>
    <div style="position:relative"><img id="layered" src="/lc_tree.jpg" style="height:150px"></div>
  </div>
  <div style="height:2600px"></div>
  <img id="far" src="/wm_crossproduct.gif" style="width:400px">
  <script>window.setTheme = (t) => { document.body.className = t; };</script>
  </body></html>`;
}

function serve(handler) {
  return new Promise((resolve) => {
    const s = createServer(handler).listen(0, '127.0.0.1', () => resolve(s));
  });
}

const imageServer = (req, res) => {
  const name = path.basename(decodeURIComponent(req.url.split('?')[0]));
  if (name === 'diagram.svg') {
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.end(SVG);
  }
  readFile(path.join(IMAGES, name)).then((buf) => res.end(buf), () => { res.statusCode = 404; res.end(); });
};
const other = await serve(imageServer); // a second origin: its images taint the page canvas
const OTHER = `http://localhost:${other.address().port}`;
const main = await serve((req, res) => {
  const m = /^\/page\/(dark|light)/.exec(req.url);
  if (m) {
    res.setHeader('Content-Type', 'text/html');
    return res.end(fixture(m[1], OTHER));
  }
  imageServer(req, res);
});
const BASE = `http://127.0.0.1:${main.address().port}`;

// ---------------------------------------------------------------------- helpers

const verdictOf = (page, id) => page.evaluate((id) => {
  const el = document.getElementById(id);
  return { v: el.getAttribute('data-inkflip'), l: el.getAttribute('data-inkflip-l'), filter: getComputedStyle(el).filter };
}, id);


const settled = (page, ids) => waitFor(page, (ids) => ids.every((id) => {
  const el = document.getElementById(id);
  return el && el.hasAttribute('data-inkflip');
}), ids);

async function popupShot(context, id, pageUrlPart, file) {
  const ctl = context.pages().find((p) => p.url().startsWith('chrome-extension://'));
  const target = await ctl.evaluate(async (part) => (await chrome.tabs.query({})).find((t) => (t.url || "").includes(part))?.id, pageUrlPart);
  const pop = await context.newPage();
  await pop.setViewportSize({ width: 340, height: 600 });
  await pop.goto(`chrome-extension://${id}/popup/popup.html?tab=${target}`);
  await pop.waitForTimeout(1300);
  const h = await pop.evaluate(() => document.documentElement.scrollHeight);
  await pop.setViewportSize({ width: 340, height: h });
  await pop.screenshot({ path: path.join(SHOTS, file) });
  const text = await pop.evaluate(() => ({
    status: document.querySelector('#status span').textContent,
    flip: document.getElementById('n-flip').textContent,
  }));
  await pop.close();
  return text;
}

// ------------------------------------------------------------- part 1: Inkflip only

await access(path.join(IMAGES, 'lc_closestplane.jpg')).catch(() => {
  console.error('Run `npm run test:real` once first: it downloads the test images.');
  process.exit(2);
});

console.log('Inkflip on a dark fixture page');
{
  const { context, id, ctl } = await launch([EXT]);
  const page = await context.newPage();
  await page.goto(BASE + '/page/dark');
  const ids = ['same-diagram', 'x-diagram', 'x-svg', 'chart', 'logo', 'product', 'list', 'photo'];
  check('every visible image gets a verdict', await settled(page, ids));
  await page.waitForTimeout(300);
  const f1 = await flashes(page);
  check('no image ever shows white first (first visit, empty cache)', !Object.keys(f1).length, JSON.stringify(f1));
  check('photos are revealed once checked', (await page.evaluate(() => getComputedStyle(document.getElementById('photo')).opacity)) === '1');
  const expect = { 'same-diagram': 'flip', 'x-diagram': 'flip', 'x-svg': 'flip', chart: 'flip', logo: 'logo', product: 'dim', list: 'flip', photo: 'none' };
  for (const [el, want] of Object.entries(expect)) {
    const got = await verdictOf(page, el);
    const styled = want === 'none' ? got.filter === 'none' : got.l !== null && got.filter !== 'none';
    check(`${el}: ${want}`, got.v === want && styled, JSON.stringify(got));
  }
  check('flip lands white just under the page colour (#181a1b → invert 0.92, lighten)', await waitFor(page,
    () => {
      const cs = getComputedStyle(document.getElementById('same-diagram'));
      return cs.filter.startsWith('invert(0.92)') && cs.mixBlendMode === 'lighten';
    }, null, 2000),
  (await verdictOf(page, 'same-diagram')).filter);

  await settled(page, ['avatar']);
  const avatar = await page.evaluate(() => {
    const el = document.getElementById('avatar');
    const cs = getComputedStyle(el);
    return { v: el.getAttribute('data-inkflip'), l: el.getAttribute('data-inkflip-l'), filter: cs.filter, opacity: cs.opacity };
  });
  check('a photo at avatar size is classified but never flipped, dimmed or hidden',
    avatar.v === 'dim' && avatar.l === null && avatar.filter === 'none' && avatar.opacity === '1', JSON.stringify(avatar));

  await settled(page, ['layered']);
  const layered = await verdictOf(page, 'layered');
  check('backdrop comes from what is painted behind, not the parent chain (#2a2d31 → 16)', layered.l === '16', JSON.stringify(layered));

  const far = await verdictOf(page, 'far');
  check('images far below the fold wait until scrolled near', far.v === null, JSON.stringify(far));
  await page.evaluate(() => document.getElementById('far').scrollIntoView());
  check('…and are classified once they are', await waitFor(page, () => document.getElementById('far').getAttribute('data-inkflip') === 'flip'));
  await page.evaluate(() => scrollTo(0, 0));

  if (argv.has('--shots')) {
    await page.waitForTimeout(400);
    await settings(ctl, { badges: true });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SHOTS, 'badges.png') });
    await settings(ctl, { badges: false });
  }

  await page.reload();
  check('reload: verdicts come straight from the cache', await settled(page, ids));
  await page.waitForTimeout(300);
  const f2 = await flashes(page);
  check('reload: still no white frame', !Object.keys(f2).length, JSON.stringify(f2));

  await page.evaluate(() => window.setTheme('light'));
  check('page turns light → Inkflip stands by', await waitFor(page, () => !document.getElementById('same-diagram').hasAttribute('data-inkflip-l')));
  check('…and nothing is hidden on a light page', (await page.evaluate(() => getComputedStyle(document.getElementById('same-diagram')).opacity)) === '1');
  await page.evaluate(() => window.setTheme('dark'));
  check('page turns dark again → flips return', await waitFor(page, () => document.getElementById('same-diagram').hasAttribute('data-inkflip-l')));

  await page.keyboard.down('Alt');
  const peeked = await waitFor(page, () => getComputedStyle(document.getElementById('same-diagram')).filter === 'none', null, 2000);
  await page.keyboard.up('Alt');
  check('holding Alt shows the original', peeked);
  check('releasing Alt flips it back', await waitFor(page, () => getComputedStyle(document.getElementById('same-diagram')).filter !== 'none'));

  await settings(ctl, { disabledHosts: ['127.0.0.1'] });
  check('turning the site off removes every filter', await waitFor(page, () => getComputedStyle(document.getElementById('same-diagram')).filter === 'none'));
  await settings(ctl, { disabledHosts: [] });
  check('turning it back on restores them', await waitFor(page, () => getComputedStyle(document.getElementById('same-diagram')).filter !== 'none'));

  await settings(ctl, { dim: false });
  check('switching off Dim leaves photos alone', await waitFor(page, () => getComputedStyle(document.getElementById('product')).filter === 'none'));
  await settings(ctl, { dim: true });

  await ctl.evaluate(async (src) => chrome.storage.local.set({ 'ovr:127.0.0.1': { [src]: 'flip' } }), BASE + '/photo_b.jpg');
  check('a right-click choice overrides the verdict', await waitFor(page, () => document.getElementById('photo').getAttribute('data-inkflip') === 'flip'));
  await ctl.evaluate(async () => chrome.storage.local.remove('ovr:127.0.0.1'));
  check('"Let Inkflip decide" undoes it', await waitFor(page, () => document.getElementById('photo').getAttribute('data-inkflip') === 'none'));

  const cached = await ctl.evaluate(async (url) => {
    const db = await new Promise((r) => { const q = indexedDB.open('inkflip', 1); q.onsuccess = () => r(q.result); });
    return new Promise((r) => { const q = db.transaction('verdicts').objectStore('verdicts').get(url); q.onsuccess = () => r(q.result?.verdict); });
  }, OTHER + '/lc_tree.jpg');
  check('cross-origin verdicts are cached', cached === 'flip', String(cached));

  await context.close();
}

// ------------------------------------------------------- part 2: next to Dark Reader

let haveDr = true;
await access(path.join(DR, 'manifest.json')).catch(() => { haveDr = false; });
if (!haveDr) {
  console.log('\n(skipping Dark Reader checks: unpack its MV3 build into test/.cache/darkreader)');
} else {
  console.log('\nInkflip next to Dark Reader on a light page');
  const { context, id, ctl } = await launch([EXT, DR]);
  const page = await context.newPage();
  await page.goto(BASE + '/page/light');
  check('Dark Reader darkens the page', await waitFor(page, () => {
    const c = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number);
    return c[0] < 60;
  }, null, 10000));
  check('…and Inkflip flips the diagram', await waitFor(page, () => document.getElementById('same-diagram').getAttribute('data-inkflip-l') !== null, null, 10000));
  const dr = await verdictOf(page, 'x-svg');
  check('cross-origin SVG flips under Dark Reader too', dr.v === 'flip' && dr.l !== null, JSON.stringify(dr));
  const photo = await verdictOf(page, 'photo');
  check('photos stay untouched', photo.v === 'none' && photo.filter === 'none', JSON.stringify(photo));
  await page.waitForTimeout(300);
  const f3 = await flashes(page);
  check('no white frame while Dark Reader and Inkflip start together', !Object.keys(f3).length, JSON.stringify(f3));

  if (argv.has('--live')) {
    console.log('\nLeetCode 973, Dark Reader + Inkflip');
    const lc = await context.newPage();
    await lc.goto('https://leetcode.com/problems/k-closest-points-to-origin/description/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    const sel = 'img[src*="closestplane1"]';
    const found = await lc.waitForSelector(sel, { timeout: 30000 }).then(() => true, () => false);
    check('the diagram is on the page', found, await lc.title());
    if (found) {
      const flipped = await waitFor(lc, (sel) => document.querySelector(sel)?.getAttribute('data-inkflip-l') !== null &&
        document.querySelector(sel)?.getAttribute('data-inkflip') === 'flip', sel, 20000);
      const info = await lc.evaluate((sel) => {
        const el = document.querySelector(sel);
        return { v: el.getAttribute('data-inkflip'), l: el.getAttribute('data-inkflip-l'), filter: getComputedStyle(el).filter };
      }, sel);
      check('Inkflip flips it', flipped, JSON.stringify(info));
      await lc.waitForTimeout(500);
      const lf1 = await flashes(lc);
      check('first visit: the diagram never shows white', !Object.keys(lf1).length, JSON.stringify(lf1));
      await lc.reload({ waitUntil: 'domcontentloaded' });
      await lc.waitForSelector(sel, { timeout: 30000 });
      await waitFor(lc, (sel) => document.querySelector(sel)?.getAttribute('data-inkflip-l') !== null, sel, 20000);
      await lc.waitForTimeout(500);
      const lf2 = await flashes(lc);
      check('reload: the diagram never shows white', !Object.keys(lf2).length, JSON.stringify(lf2));
      if (argv.has('--shots')) {
        await lc.locator(sel).scrollIntoViewIfNeeded();
        await lc.waitForTimeout(800);
        await lc.screenshot({ path: path.join(SHOTS, 'leetcode-after.png') });
        console.log('  · popup:', JSON.stringify(await popupShot(context, id, 'leetcode.com', 'popup-leetcode.png')));
        await settings(ctl, { disabledHosts: ['leetcode.com'] });
        await lc.waitForTimeout(800);
        await lc.screenshot({ path: path.join(SHOTS, 'leetcode-before.png') });
        await settings(ctl, { disabledHosts: [] });
      }
    }
  }
  await context.close();
}

main.close();
other.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);

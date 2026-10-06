// Field test: runs Dark Reader + Inkflip headless on the real pages listed in
// research/field-pages.tsv and records what Inkflip did on each one.
//
//   node test/field.mjs [--only id,id] [--jobs 3]
//
// For every page it scrolls the whole page once (lazy images, near-viewport checks), then
// centres the most prominent image Inkflip changed and captures three JPEGs into
// screenshots/field/: <id>-after (Dark Reader + Inkflip), <id>-badges (verdict labels) and
// <id>-before (Dark Reader alone, same scroll position). Per-image verdicts, white-flash
// counts, images left hidden and extension errors go to screenshots/field/results.json.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { root, EXT, DR, launch, settings, flashes } from './lib.mjs';

const OUT = path.join(root, 'screenshots/field');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const only = opt('--only') ? new Set(opt('--only').split(',')) : null;
const jobs = Number(opt('--jobs') || 3);
// A dark-mode user's OS reports a dark colour scheme, which changes what many sites serve
// (their own dark themes, GitHub's dark-mode logos). --light runs the light-scheme case.
const colorScheme = args.includes('--light') ? 'light' : 'dark';

const pages = (await readFile(path.join(root, 'research/field-pages.tsv'), 'utf8'))
  .trim().split('\n').slice(1).filter((l) => l && !l.startsWith('#'))
  .map((l) => { const [id, category, url, expect] = l.split('\t'); return { id, category, url, expect }; })
  .filter((p) => !only || only.has(p.id));

await mkdir(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every <img> on the page with what Inkflip did to it. */
const collect = (page) => page.evaluate(() => [...document.images].map((img, i) => {
  img.setAttribute('data-field-i', i);
  const r = img.getBoundingClientRect();
  const cs = getComputedStyle(img);
  return {
    i, src: img.currentSrc || img.src, v: img.getAttribute('data-inkflip'), l: img.getAttribute('data-inkflip-l'),
    wait: img.hasAttribute('data-inkflip-wait'), w: Math.round(r.width), h: Math.round(r.height),
    top: Math.round(r.top + scrollY), nw: img.naturalWidth, nh: img.naturalHeight, complete: img.complete,
    filter: cs.filter, blend: cs.mixBlendMode, opacity: cs.opacity, shown: cs.display !== 'none' && cs.visibility !== 'hidden',
  };
}));

/** Scroll the window, and any large inner scroll panel (LeetCode's), through once. */
async function autoScroll(page) {
  await page.evaluate(async () => {
    const pause = () => new Promise((r) => setTimeout(r, 300));
    const step = innerHeight * 0.8;
    const max = Math.min(document.documentElement.scrollHeight, innerHeight * 12);
    for (let y = 0; y < max; y += step) { scrollTo(0, y); await pause(); }
    scrollTo(0, 0);
    const panels = [...document.querySelectorAll('div, main, section, article')].filter((el) => {
      const cs = getComputedStyle(el);
      return /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 200 && el.clientHeight > 300;
    }).slice(0, 3);
    for (const el of panels) {
      for (let y = 0; y < Math.min(el.scrollHeight, el.clientHeight * 10); y += el.clientHeight * 0.8) { el.scrollTop = y; await pause(); }
      el.scrollTop = 0;
    }
  }).catch(() => {});
}

/**
 * An image still marked "wait" is only a bug if the user could see it. Scroll each candidate
 * into view, wait past the 1.5 s watchdog, and keep the ones that are on screen, not clipped
 * (hit-testable at their centre) and still hidden.
 */
async function verifyStuck(page, candidates) {
  const stuck = [];
  for (const m of candidates.slice(0, 8)) {
    const res = await page.evaluate(async (i) => {
      const img = document.querySelector(`img[data-field-i="${i}"]`);
      if (!img) return null;
      img.scrollIntoView({ block: 'center' });
      await new Promise((r) => setTimeout(r, 1800));
      const r = img.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const onScreen = r.width > 0 && x > 0 && y > 0 && x < innerWidth && y < innerHeight;
      const visible = onScreen && document.elementsFromPoint(x, y).includes(img);
      return { visible, wait: img.hasAttribute('data-inkflip-wait') };
    }, m.i).catch(() => null);
    if (res && res.visible && res.wait) stuck.push({ src: m.src, top: m.top, w: m.w, h: m.h });
  }
  return stuck;
}

async function signalsFor(ctl, urls) {
  return ctl.evaluate(async (urls) => {
    const db = await new Promise((r) => { const q = indexedDB.open('inkflip', 1); q.onsuccess = () => r(q.result); q.onerror = () => r(null); });
    if (!db) return {};
    const store = db.transaction('verdicts').objectStore('verdicts');
    const out = {};
    await Promise.all(urls.map((u) => new Promise((r) => {
      const q = store.get(u);
      q.onsuccess = () => { if (q.result) out[u] = q.result.signals; r(); };
      q.onerror = () => r();
    })));
    return out;
  }, urls).catch(() => ({}));
}

async function runPage(env, p) {
  const { context, id, ctl } = env;
  const host = new URL(p.url).hostname;
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && (m.location().url || '').startsWith(`chrome-extension://${id}`)) errors.push(m.text());
  });
  const rec = { ...p, host, status: 'ok' };
  const t0 = Date.now();
  try {
    await page.goto(p.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    rec.status = 'load failed: ' + e.message.split('\n')[0];
  }
  await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
  await sleep(2500);
  await page.keyboard.press('Escape').catch(() => {}); // close sign-up pop-ups where Escape works
  await autoScroll(page);
  await sleep(1500);
  rec.title = await page.title().catch(() => '');
  rec.loadMs = Date.now() - t0;
  rec.darkReader = await page.evaluate(() => document.documentElement.getAttribute('data-darkreader-mode')).catch(() => null);
  const imgs = await collect(page).catch(() => []);

  // Focus on the most prominent changed image (flip > logo > dim, then size).
  const rank = { flip: 3, logo: 2, dim: 1 };
  const changed = imgs.filter((m) => m.l !== null && rank[m.v] && m.w >= 40 && m.h >= 24)
    .sort((a, b) => rank[b.v] - rank[a.v] || b.w * b.h - a.w * a.h);
  rec.focus = changed[0] ? changed[0].i : null;
  if (rec.focus !== null) {
    await page.evaluate((i) => document.querySelector(`img[data-field-i="${i}"]`)?.scrollIntoView({ block: 'center' }), rec.focus).catch(() => {});
  } else {
    await page.evaluate(() => scrollTo(0, 0)).catch(() => {});
  }
  await sleep(900);
  // Capture through the DevTools protocol: Playwright's screenshot waits for web fonts,
  // which never settle on some sites.
  const cdp = await context.newCDPSession(page);
  rec.shotErrors = [];
  const shot = async (name) => {
    try {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 85 });
      await writeFile(path.join(OUT, `${p.id}-${name}.jpg`), Buffer.from(data, 'base64'));
    } catch (e) {
      rec.shotErrors.push(`${name}: ${e.message.split('\n')[0]}`);
    }
  };
  await shot('after');
  rec.flashes = await flashes(page).catch(() => ({}));
  const settled = await collect(page).catch(() => imgs);

  await settings(ctl, { badges: true });
  await sleep(600);
  await shot('badges');
  await settings(ctl, { badges: false });

  await settings(ctl, { disabledHosts: [host] });
  await sleep(700);
  await shot('before');
  await settings(ctl, { disabledHosts: [] });

  const counts = { flip: 0, logo: 0, dim: 0, none: 0, standby: 0, unchecked: 0 };
  for (const m of settled) {
    if (m.w < 8 || m.h < 8) continue;
    if (!m.v) counts.unchecked++;
    else if (m.v !== 'none' && m.l === null) counts.standby++;
    else counts[m.v]++;
  }
  rec.counts = counts;
  rec.stuck = await verifyStuck(page, settled.filter((m) => m.wait && m.complete && m.nw > 0 && m.shown));
  const interesting = settled.filter((m) => m.v && m.w >= 32 && m.h >= 24);
  const sig = await signalsFor(ctl, interesting.map((m) => m.src));
  rec.images = settled.filter((m) => m.w >= 8 && m.h >= 8).map((m) => ({ ...m, signals: sig[m.src] || null }));
  rec.errors = errors;
  await page.close();
  const c = counts;
  console.log(`${p.id.padEnd(24)} ${rec.status === 'ok' ? '' : rec.status + ' '}flip ${c.flip} logo ${c.logo} dim ${c.dim} none ${c.none}` +
    ` standby ${c.standby} unchecked ${c.unchecked}${Object.keys(rec.flashes).length ? ' FLASH' : ''}` +
    `${rec.stuck.length ? ' STUCK ' + rec.stuck.length : ''}${errors.length ? ' ERRORS ' + errors.length : ''}` +
    `${rec.shotErrors.length ? ' SHOT-FAILED ' + rec.shotErrors.join('; ') : ''}`);
  return rec;
}

const queue = [...pages];
const results = [];
async function worker() {
  const env = await launch([EXT, DR], { colorScheme });
  while (queue.length) {
    const p = queue.shift();
    try {
      results.push(await runPage(env, p));
    } catch (e) {
      console.log(`${p.id.padEnd(24)} crashed: ${e.message.split('\n')[0]}`);
      results.push({ ...p, status: 'crashed: ' + e.message.split('\n')[0] });
    }
  }
  await env.context.close();
}
await Promise.all(Array.from({ length: Math.min(jobs, pages.length) }, worker));

const order = new Map(pages.map((p, i) => [p.id, i]));
results.sort((a, b) => order.get(a.id) - order.get(b.id));
let previous = [];
try { previous = JSON.parse(await readFile(path.join(OUT, 'results.json'), 'utf8')); } catch { /* first run */ }
const merged = new Map(previous.map((r) => [r.id, r]));
for (const r of results) merged.set(r.id, r);
await writeFile(path.join(OUT, 'results.json'), JSON.stringify([...merged.values()], null, 1));
console.log(`\n${results.length} pages → screenshots/field/`);

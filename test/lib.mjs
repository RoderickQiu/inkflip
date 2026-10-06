// Shared by the end-to-end test and the field test: launching Chromium headless with the
// extension (and optionally Dark Reader), driving settings, and the white-flash monitor.
import { chromium } from 'playwright';
import { mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const EXT = path.join(root, 'extension');
export const DR = path.join(root, 'test/.cache/darkreader');
const headed = process.argv.includes('--headed');

let userAgent = null;
export async function plainUserAgent() {
  if (!userAgent) {
    const b = await chromium.launch({ channel: 'chromium', headless: true });
    userAgent = (await (await b.newPage()).evaluate(() => navigator.userAgent)).replace('HeadlessChrome', 'Chrome');
    await b.close();
  }
  return userAgent;
}

// Runs in every page before its own scripts: counts frames in which an image is on screen,
// loaded, fully opaque and unfiltered while the page behind it is dark. The check runs in a
// ResizeObserver callback, which comes after every requestAnimationFrame callback and right
// before paint, so it sees exactly what gets painted. Any such frame for an image that
// Inkflip ended up flipping or dimming was a white flash.
export function flashMonitor() {
  window.__white = {};
  const lum = (s) => {
    const m = (s || '').match(/[\d.]+/g);
    if (!m) return null;
    const [r, g, b, a = 1] = m.map(Number);
    return a < 0.5 ? null : (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  };
  const check = () => {
    if (!document.body) return;
    let L = lum(getComputedStyle(document.body).backgroundColor);
    if (L === null) L = lum(getComputedStyle(document.documentElement).backgroundColor);
    if (L === null || L >= 0.4) return;
    for (const img of document.images) {
      if (!img.complete || !img.naturalWidth) continue;
      const cs = getComputedStyle(img);
      if (cs.opacity === '0' || cs.filter !== 'none' || cs.visibility === 'hidden') continue;
      const r = img.getBoundingClientRect();
      if (!r.width || r.bottom < 0 || r.top > innerHeight) continue;
      if (r.width <= 48 && r.height <= 48) continue; // small images are shown at once by design
      const key = img.id || img.currentSrc;
      window.__white[key] = (window.__white[key] || 0) + 1;
    }
  };
  const probe = document.createElement('flash-probe');
  probe.style.cssText = 'position:fixed;left:0;top:0;height:1px;width:1px;pointer-events:none;visibility:hidden';
  new ResizeObserver(check).observe(probe);
  let wide = false;
  const tick = () => {
    if (!probe.isConnected) document.documentElement.appendChild(probe);
    probe.style.width = (wide = !wide) ? '2px' : '1px'; // a size change every frame
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** White frames shown by images that Inkflip ended up flipping, brightening or dimming. */
export const flashes = (page) => page.evaluate(() => {
  const out = {};
  for (const img of document.images) {
    const v = img.getAttribute('data-inkflip');
    if (!img.hasAttribute('data-inkflip-l') || !['flip', 'logo', 'dim'].includes(v)) continue;
    const key = img.id || img.currentSrc;
    if (window.__white[key]) out[key.split('/').pop()] = window.__white[key];
  }
  return out;
});

export async function launch(extensions, { colorScheme = 'light' } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'inkflip-e2e-'));
  const context = await chromium.launchPersistentContext(dir, {
    channel: 'chromium',
    headless: !headed,
    userAgent: await plainUserAgent(),
    colorScheme,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    args: [
      `--disable-extensions-except=${extensions.join(',')}`, `--load-extension=${extensions.join(',')}`,
      '--disable-blink-features=AutomationControlled',
    ],
  });
  await context.addInitScript(flashMonitor);
  const ours = () => context.serviceWorkers().find((w) => w.url().endsWith('/background.js'));
  let sw = ours();
  for (let i = 0; !sw && i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    sw = ours();
  }
  const id = sw.url().split('/')[2];
  // An extension page to drive chrome.storage from (service workers can go to sleep).
  const ctl = await context.newPage();
  await ctl.goto(`chrome-extension://${id}/popup/popup.html`);
  return { context, id, ctl };
}

export const settings = (ctl, patch) => ctl.evaluate(async (patch) => {
  const { settings } = await chrome.storage.sync.get('settings');
  await chrome.storage.sync.set({ settings: { ...settings, ...patch } });
}, patch);

export async function waitFor(page, fn, arg, timeout = 8000) {
  try {
    await page.waitForFunction(fn, arg, { timeout, polling: 100 });
    return true;
  } catch {
    return false;
  }
}

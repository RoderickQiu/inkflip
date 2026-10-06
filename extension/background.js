/*
 * Inkflip service worker.
 *
 * - Reads cross-origin images that the page's canvas can't (they would taint it): fetches
 *   them under the extension's host permission, samples them on an OffscreenCanvas and
 *   returns only the verdict and signals. Nothing leaves the machine.
 * - Caches verdicts by image URL in IndexedDB so repeat visits never flash white.
 * - Owns the right-click menu (per-image corrections) and the keyboard shortcut.
 */
importScripts('defaults.js', 'classifier.js');

const C = self.InkflipClassifier;
const MODEL = 1; // bump when the classifier changes; older cache entries are ignored
const CACHE_LIMIT = 20000;
const DEFAULTS = self.INKFLIP_DEFAULTS;

// ------------------------------------------------------------------ verdict cache

let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('inkflip', 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore('verdicts', { keyPath: 'url' });
        store.createIndex('ts', 'ts');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function cacheGet(urls) {
  const store = (await db()).transaction('verdicts').objectStore('verdicts');
  const out = {};
  await Promise.all(urls.map((url) => new Promise((resolve) => {
    const req = store.get(url);
    req.onsuccess = () => {
      const rec = req.result;
      if (rec && rec.model === MODEL) out[url] = { verdict: rec.verdict, signals: rec.signals };
      resolve();
    };
    req.onerror = () => resolve();
  })));
  return out;
}

let writes = 0;

async function cachePut(url, result) {
  const tx = (await db()).transaction('verdicts', 'readwrite');
  tx.objectStore('verdicts').put({
    url, verdict: result.verdict, signals: result.signals, model: MODEL, ts: Date.now(),
  });
  if (++writes % 200 === 0) prune();
}

/** Keep the cache under CACHE_LIMIT entries by dropping the oldest. */
async function prune() {
  const store = (await db()).transaction('verdicts', 'readwrite').objectStore('verdicts');
  const countReq = store.count();
  countReq.onsuccess = () => {
    let excess = countReq.result - CACHE_LIMIT;
    if (excess <= 0) return;
    store.index('ts').openCursor().onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor || excess-- <= 0) return;
      cursor.delete();
      cursor.continue();
    };
  };
}

// ---------------------------------------------------------------------- analysis

const inflight = new Map(); // url -> Promise, so repeated images are fetched once

async function analyzeUrl(url) {
  const res = await fetch(url, { credentials: 'include', cache: 'force-cache' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const type = res.headers.get('content-type') || '';
  const blob = await res.blob();
  if (type.includes('svg') || /\.svg([?#]|$)/i.test(url)) {
    // Workers can't decode SVG; the content script rasterises it and reports back.
    return { svg: await blob.text() };
  }
  const bitmap = await createImageBitmap(blob);
  const [tw, th] = C.sampleSize(bitmap.width, bitmap.height);
  const canvas = new OffscreenCanvas(tw, th);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0, tw, th);
  bitmap.close();
  const result = C.classify(ctx.getImageData(0, 0, tw, th).data, tw, th);
  cachePut(url, result).catch(() => {});
  return result;
}

async function analyze(url) {
  const hit = (await cacheGet([url]).catch(() => ({})))[url];
  if (hit) return hit;
  if (!inflight.has(url)) {
    inflight.set(url, analyzeUrl(url).finally(() => inflight.delete(url)));
  }
  return inflight.get(url);
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'analyze') {
    analyze(msg.url).then(reply, () => reply(null));
    return true;
  }
  if (msg.type === 'lookup') {
    cacheGet(msg.urls || []).then(reply, () => reply({}));
    return true;
  }
  if (msg.type === 'remember' && msg.result) {
    cachePut(msg.url, msg.result).catch(() => {});
  }
});

// --------------------------------------------------------- right-click corrections

const MENU = [
  ['inkflip-flip', 'Flip this image (make it dark)'],
  ['inkflip-dim', 'Dim this image'],
  ['inkflip-none', 'Show this image as is'],
  ['inkflip-sep', null],
  ['inkflip-auto', 'Let Inkflip decide'],
];

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.sync.get('settings');
  await chrome.storage.sync.set({ settings: { ...DEFAULTS, ...(settings || {}) } });
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'inkflip', title: 'Inkflip', contexts: ['image'] });
    for (const [id, title] of MENU) {
      chrome.contextMenus.create(title
        ? { id, parentId: 'inkflip', title, contexts: ['image'] }
        : { id, parentId: 'inkflip', type: 'separator', contexts: ['image'] });
    }
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const choice = { 'inkflip-flip': 'flip', 'inkflip-dim': 'dim', 'inkflip-none': 'none', 'inkflip-auto': null }[info.menuItemId];
  if (choice === undefined || !info.srcUrl) return;
  let host = hostOf(tab && tab.url);
  if (host === null) host = hostOf(info.pageUrl);
  if (host === null) return;
  const key = 'ovr:' + host;
  const overrides = (await chrome.storage.local.get(key))[key] || {};
  if (choice) overrides[info.srcUrl] = choice;
  else delete overrides[info.srcUrl];
  await chrome.storage.local.set({ [key]: overrides });
});

// --------------------------------------------------------------- keyboard shortcut

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-site') return;
  tab = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const host = hostOf(tab && tab.url);
  if (host === null) return;
  const { settings } = await chrome.storage.sync.get('settings');
  const s = { ...DEFAULTS, ...(settings || {}) };
  s.disabledHosts = s.disabledHosts.includes(host)
    ? s.disabledHosts.filter((h) => h !== host)
    : [...s.disabledHosts, host];
  await chrome.storage.sync.set({ settings: s });
});

function hostOf(url) {
  try {
    const u = new URL(url);
    return /^(https?|file):$/.test(u.protocol) ? u.hostname : null; // '' for local files
  } catch (e) {
    return null;
  }
}

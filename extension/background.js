/*
 * Inkflip service worker.
 *
 * - Reads cross-origin images that the page's canvas can't (they would taint it): fetches
 *   them under the extension's host permission, samples them on an OffscreenCanvas and
 *   returns only the verdict and signals. Nothing leaves the machine.
 * - Caches verdicts by image URL in IndexedDB so repeat visits never flash white.
 * - Owns the right-click menu (corrections for images, canvases and videos) and the keyboard
 *   shortcut.
 */
importScripts('defaults.js', 'classifier.js');

const C = self.InkflipClassifier;
const MODEL = 4; // bump when the classifier changes; older cache entries are ignored
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

// Chrome sends no Referer on extension requests, and hotlink-protected image hosts (Stack
// Overflow's i.sstatic.net, for one) refuse requests without one. A session rule, limited to
// our own requests, sends the page's origin instead: the page sent that same Referer when it
// loaded the image, so the host learns nothing new.
const refererByRule = new Map();

async function sendRefererFor(url, page) {
  let host, referer;
  try {
    host = new URL(url).hostname;
    referer = new URL(page).origin + '/';
  } catch (e) {
    return;
  }
  if (!/^https?:/.test(referer)) return;
  let h = 0;
  for (const ch of host) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const id = (h % 1000000) + 1;
  if (refererByRule.get(id) === host + referer) return;
  refererByRule.set(id, host + referer);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [{
      id,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'referer', operation: 'set', value: referer }] },
      condition: {
        urlFilter: `||${host}/`,
        initiatorDomains: [chrome.runtime.id],
        resourceTypes: ['xmlhttprequest', 'other'],
      },
    }],
  }).catch(() => {});
}

async function analyzeUrl(url, page) {
  await sendRefererFor(url, page);
  const res = await fetch(url, { credentials: 'include', cache: 'force-cache' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const type = res.headers.get('content-type') || '';
  const blob = await res.blob();
  if (type.includes('svg') || /\.svg([?#]|$)/i.test(url)) {
    // Workers can't decode SVG; the content script rasterises it and reports back.
    return { svg: await blob.text() };
  }
  const bitmap = await createImageBitmap(blob);
  const px = C.pixels(bitmap, bitmap.width, bitmap.height, false);
  bitmap.close();
  const result = C.classify(px.data, px.w, px.h);
  cachePut(url, result).catch(() => {});
  return result;
}

async function analyze(url, page) {
  const hit = (await cacheGet([url]).catch(() => ({})))[url];
  if (hit) return hit;
  if (!inflight.has(url)) {
    inflight.set(url, analyzeUrl(url, page).finally(() => inflight.delete(url)));
  }
  return inflight.get(url);
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'analyze') {
    analyze(msg.url, msg.page || (sender.tab && sender.tab.url)).then(reply, () => reply(null));
    return true;
  }
  if (msg.type === 'lookup') {
    cacheGet(msg.urls || []).then(reply, () => reply({}));
    return true;
  }
  if (msg.type === 'remember' && msg.result) {
    cachePut(msg.url, msg.result).catch(() => {});
  }
  if (msg.type === 'menu') showMenu(msg.kind || null, msg.t);
});

// --------------------------------------------------------- right-click corrections

const CHOICES = [
  ['flip', (noun) => `Flip this ${noun} (make it dark)`],
  ['dim', (noun) => `Dim this ${noun}`],
  ['none', (noun) => `Show this ${noun} as is`],
  ['sep', null],
  ['auto', () => 'Let Inkflip decide'],
];

// One menu for images, canvases and videos. A canvas matches no context but "all", and
// neither does an image or a video under a transparent layer, so the menu has to be an "all"
// one. It stays hidden until the content script reports one of them under the pointer.
// It has to be the only top-level entry: when two of an extension's entries match a click,
// Chrome nests them under the extension's full name, hidden ones included.
// A canvas is called an image here, as in Chrome's own "Save image as".
const MENU = 'inkflip';
const PAGES = ['http://*/*', 'https://*/*', 'file:///*'];
const ignore = () => void chrome.runtime.lastError;

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    const base = { contexts: ['all'], documentUrlPatterns: PAGES };
    chrome.contextMenus.create({ ...base, id: MENU, title: 'Inkflip', visible: false }, ignore);
    for (const [choice, title] of CHOICES) {
      const id = `${MENU}:${choice}`;
      chrome.contextMenus.create(title
        ? { ...base, id, parentId: MENU, title: title('image') }
        : { ...base, id, parentId: MENU, type: 'separator' }, ignore);
    }
  });
  shown = null;
  noun = 'image';
}

let shown; // 'image' | 'video' | null; undefined after a restart, until the next report
let noun = 'image'; // what the entries currently say
let shownAt = 0;

/** Show the menu for a kind of element, worded for it, or hide it. Late reports are dropped. */
function showMenu(kind, t = Date.now()) {
  if (t < shownAt) return; // frames report out of order when the pointer crosses between them
  shownAt = t;
  if (kind === shown) return;
  shown = kind;
  chrome.contextMenus.update(MENU, { visible: !!kind }, ignore);
  if (kind && kind !== noun) {
    noun = kind;
    for (const [choice, title] of CHOICES) {
      if (title && choice !== 'auto') chrome.contextMenus.update(`${MENU}:${choice}`, { title: title(kind) }, ignore);
    }
  }
}

chrome.tabs.onActivated.addListener(() => showMenu(null));

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.sync.get('settings');
  await chrome.storage.sync.set({ settings: { ...DEFAULTS, ...(settings || {}) } });
  createMenus();
});

/**
 * Remember a choice for this site. An image is keyed by its URL, which Chrome hands over for
 * one it hit directly; for anything else the frame that was right-clicked says which element
 * it was and what key it goes by.
 */
async function onMenuClick(info, tab) {
  const [menu, choice] = String(info.menuItemId).split(':');
  if (menu !== MENU || !choice || choice === 'sep') return;
  let host = hostOf(tab && tab.url);
  if (host === null) host = hostOf(info.pageUrl);
  if (host === null) return;
  let key = info.mediaType === 'image' ? info.srcUrl : null;
  if (!key && tab && tab.id >= 0) {
    key = await chrome.tabs.sendMessage(tab.id, { type: 'menu-target' }, { frameId: info.frameId || 0 })
      .catch(() => null);
  }
  if (!key && info.mediaType === 'video' && /^https?:/.test(info.srcUrl || '')) key = info.srcUrl;
  if (!key) return;
  const store = 'ovr:' + host;
  const overrides = (await chrome.storage.local.get(store))[store] || {};
  if (choice === 'auto') delete overrides[key];
  else overrides[key] = choice;
  await chrome.storage.local.set({ [store]: overrides });
}

chrome.contextMenus.onClicked.addListener((info, tab) => { onMenuClick(info, tab); });

// For the end-to-end test, which can't open Chrome's native menu.
self.inkflipTest = { menuClick: onMenuClick, menuShown: () => shown ?? null };

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

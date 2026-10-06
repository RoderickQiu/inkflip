/*
 * Inkflip content script.
 *
 * Finds <img> elements, gets a verdict for each one (from the user's right-click choice,
 * the shared cache, or by sampling its pixels), and tags it with data-inkflip="flip|logo|dim|none".
 * A single injected stylesheet turns those tags into CSS filters, but only while the image
 * actually sits on a dark background, which is what data-inkflip-l (the backdrop's lightness)
 * records. Page colours, CSS background images and inline SVG are left to Dark Reader.
 *
 * No white flash: on dark pages a new image carries data-inkflip-wait (opacity 0) from the
 * moment it enters the DOM until its verdict is in, so it first appears already flipped.
 */
(() => {
  'use strict';
  if (globalThis.__inkflipLoaded || !(document.documentElement instanceof HTMLElement)) return;
  globalThis.__inkflipLoaded = true;

  const C = globalThis.InkflipClassifier;
  const DEFAULTS = globalThis.INKFLIP_DEFAULTS;
  const ATTR = 'data-inkflip';
  const ATTR_L = 'data-inkflip-l';
  const WAIT = 'data-inkflip-wait';
  const PEEK = 'data-inkflip-peek';
  const DARK_PAGE = 0.40; // a backdrop at or below this lightness counts as dark
  const MAX_WAIT = 2500; // ms a loaded, on-screen image may stay hidden while it is checked
  const SMALL = 48; // px: avatars, swatches, icons. Too few pixels to judge reliably and too small
                    // to glare: never hidden, never flipped or dimmed, only rescued if dark ink

  const HOST = topHost();
  const OVR_KEY = 'ovr:' + HOST;
  const DARK_KEY = 'dark:' + HOST;
  const isTop = window === window.top;

  let settings = { ...DEFAULTS };
  let overrides = {}; // image URL -> 'flip' | 'dim' | 'none', set from the right-click menu
  let ready = false; // settings have been read
  let knownDark = false; // this site was dark last time, so hold images from the first byte
  let hold = true; // hide unchecked images (true until settings say otherwise)
  let filterMode = false; // the whole page is inverted (Dark Reader's Filter mode or similar)

  const state = new WeakMap(); // img -> { src, verdict, signals, source, pending, provisional, clock }
  const tracked = new Set();
  const near = new WeakSet(); // images within the IntersectionObserver margin
  const visible = new WeakSet(); // images actually on screen: checked first

  // ---------------------------------------------------------------- stylesheet

  const style = document.createElement('style');
  style.id = 'inkflip-style';

  function isActive() {
    return ready && settings.enabled && !filterMode && !settings.disabledHosts.includes(HOST);
  }

  function buildCss() {
    let css = '';
    if (!ready || (isActive() && settings.hold)) css += `img[${WAIT}]{opacity:0 !important}\n`;
    if (!isActive()) return css;
    const hover = settings.peek === 'hover' ? ':not(:hover)' : '';
    const on = (v) => `html:not([${PEEK}]) img[${ATTR}="${v}"]`;
    if (settings.flip || settings.logo) {
      // Invert so white lands just below the backdrop's darkest channel, then blend with
      // `lighten`: the image's background takes the backdrop's exact colour (tinted panels
      // included) while the now-light ink stays on top. The element's own background colour
      // goes: sites give transparent images one (Wikipedia: white, darkened by Dark Reader),
      // and the filter would invert it into a light box.
      for (let l = 0; l <= 40; l += 2) {
        const sel = [];
        if (settings.flip) sel.push(`${on('flip')}[${ATTR_L}="${l}"]${hover}`);
        if (settings.logo) sel.push(`${on('logo')}[${ATTR_L}="${l}"]${hover}`);
        css += `${sel.join(',')}{filter:invert(${(1 - l / 100).toFixed(2)}) hue-rotate(180deg) !important;` +
          'mix-blend-mode:lighten !important;background-color:transparent !important}\n';
      }
    }
    if (settings.dim) {
      css += `${on('dim')}[${ATTR_L}]${hover}{filter:brightness(${settings.dimLevel}) !important}\n`;
    }
    return css;
  }

  function refreshStyle() {
    style.textContent = buildCss();
    if (!style.isConnected) document.documentElement.appendChild(style);
  }

  // ------------------------------------------------------------ surroundings

  const colorCtx = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
  const colorCache = new Map();

  /** Any CSS colour string (rgb, oklch, color(), ...) -> {r, g, b, a} in sRGB, or null. */
  function parseColor(str) {
    if (!str || str === 'transparent' || str === 'rgba(0, 0, 0, 0)') return null;
    let c = colorCache.get(str);
    if (c !== undefined) return c;
    const m = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(str);
    if (m) {
      c = { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
    } else {
      colorCtx.clearRect(0, 0, 1, 1);
      colorCtx.fillStyle = '#000';
      colorCtx.fillStyle = str;
      colorCtx.fillRect(0, 0, 1, 1);
      const d = colorCtx.getImageData(0, 0, 1, 1).data;
      c = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    }
    colorCache.set(str, c);
    return c;
  }

  const luma = (c) => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;

  /** Lightness of the browser canvas when nothing on the page paints a background. */
  function canvasLightness() {
    const scheme = getComputedStyle(document.documentElement).colorScheme || '';
    const dark = scheme.includes('dark') &&
      (!scheme.includes('light') || matchMedia('(prefers-color-scheme: dark)').matches);
    return dark ? 0.07 : 1;
  }

  /**
   * What the image sits on: the backdrop colour behind it, and whether anything above it
   * is already inverted (a Dark Reader INVERT rule, Filter mode, or the site's own trick).
   * Inverting inside an inverted subtree would undo it.
   *
   * The visible backdrop is often a sibling layer rather than an ancestor (LeetCode's panels
   * are), so when the image is on screen we ask the hit-test stack what is underneath it.
   * Off screen we fall back to the nearest ancestor background and look again on arrival.
   */
  function surroundings(img, rect) {
    let bg = null, inverted = false;
    for (let n = img.parentElement; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (!inverted && cs.filter !== 'none' && cs.filter.includes('invert')) inverted = true;
      if (bg === null) {
        const c = parseColor(cs.backgroundColor);
        if (c && c.a >= 0.5) bg = c;
      }
    }
    const onScreen = rect.width > 0 && rect.bottom > 0 && rect.right > 0 &&
      rect.top < innerHeight && rect.left < innerWidth;
    let measured = false;
    if (onScreen) {
      const x = Math.min(Math.max(rect.left + rect.width / 2, 0), innerWidth - 1);
      const y = Math.min(Math.max(rect.top + rect.height / 2, 0), innerHeight - 1);
      const stack = document.elementsFromPoint(x, y);
      let i = stack.indexOf(img);
      i = i >= 0 ? i + 1 : stack.findIndex((e) => e.contains(img)); // img may not be hit-testable
      for (let k = Math.max(i, 0); i >= 0 && k < stack.length; k++) {
        const c = parseColor(getComputedStyle(stack[k]).backgroundColor);
        if (c && c.a >= 0.5) { bg = c; measured = true; break; }
      }
    }
    if (bg === null) {
      const v = canvasLightness() * 255;
      bg = { r: v, g: v, b: v, a: 1 };
    }
    return { L: luma(bg), floor: Math.min(bg.r, bg.g, bg.b) / 255, inverted, measured };
  }

  function pageLightness() {
    for (const n of [document.body, document.documentElement]) {
      if (!n) continue;
      const c = parseColor(getComputedStyle(n).backgroundColor);
      if (c && c.a >= 0.5) return luma(c);
    }
    return canvasLightness();
  }

  function detectFilterMode() {
    filterMode = getComputedStyle(document.documentElement).filter.includes('invert');
  }

  function detectDarkReader() {
    const html = document.documentElement;
    if (html.hasAttribute('data-darkreader-mode')) return html.getAttribute('data-darkreader-mode');
    if (document.querySelector('style.darkreader, #dark-reader-style, meta[name="darkreader"]')) return 'on';
    return null;
  }

  /** Dark Reader is darkening this page (it may not have painted the background yet). */
  function darkReaderDark() {
    const scheme = document.documentElement.getAttribute('data-darkreader-scheme');
    return scheme ? scheme === 'dark' : detectDarkReader() !== null;
  }

  // -------------------------------------------------------------------- hold

  function holding() {
    if (!ready) return true; // a few ms before settings arrive: assume a dark page
    if (!isActive() || !settings.hold) return false;
    return knownDark || darkReaderDark() || pageLightness() <= DARK_PAGE;
  }

  function updateHold() {
    const next = holding();
    if (next === hold) return;
    hold = next;
    for (const img of tracked) {
      const st = state.get(img);
      if (next && st && !st.verdict) wait(img);
      else if (!next) img.removeAttribute(WAIT);
    }
  }

  function wait(img) {
    if (img.hasAttribute(WAIT)) return;
    img.setAttribute(WAIT, '');
    if (!watchdog) watchdog = setInterval(checkWaits, 250);
  }

  // Never keep a loaded, on-screen image hidden for long, whatever happens to its check.
  let watchdog = 0;
  function checkWaits() {
    const now = performance.now();
    let waiting = 0;
    for (const img of tracked) {
      if (!img.hasAttribute(WAIT)) continue;
      const st = state.get(img);
      if (!st || !img.isConnected) { img.removeAttribute(WAIT); continue; }
      waiting++;
      if (near.has(img) && img.complete) {
        st.clock = st.clock || now;
        if (now - st.clock > MAX_WAIT) img.removeAttribute(WAIT);
      }
    }
    if (!waiting) { clearInterval(watchdog); watchdog = 0; }
  }

  // ------------------------------------------------------------------ apply

  function apply(img) {
    const st = state.get(img);
    if (!st || !st.verdict || !img.isConnected) return;
    if (st.ownInverted === undefined) {
      // Checked once, before our own filter is on the element.
      st.ownInverted = !img.hasAttribute(ATTR_L) && getComputedStyle(img).filter.includes('invert');
    }
    const r = img.getBoundingClientRect();
    const ctx = surroundings(img, r);
    st.dark = ctx.L <= DARK_PAGE;
    st.inverted = ctx.inverted || st.ownInverted;
    st.provisional = !ctx.measured;
    st.stale = false;
    const nw = img.naturalWidth, nh = img.naturalHeight;
    const tiny = (nw > 0 && (nw < 8 || nh < 8)) || (r.width > 0 && (r.width < 8 || r.height < 8));
    const small = r.width > 0 && r.width <= SMALL && r.height <= SMALL;

    img.setAttribute(ATTR, st.verdict);
    const on = st.verdict !== 'none' && st.dark && !st.inverted && !tiny && !(small && st.verdict !== 'logo');
    if (on) {
      const l = Math.min(40, Math.floor(ctx.floor * 50) * 2); // rounded down: stays under the backdrop
      if (img.getAttribute(ATTR_L) !== String(l)) img.setAttribute(ATTR_L, String(l));
    } else if (img.hasAttribute(ATTR_L)) {
      img.removeAttribute(ATTR_L);
    }
    // Reveal now, unless the page is about to turn dark (Dark Reader still loading) and this
    // image would then need flipping: it stays hidden until then, or until the watchdog.
    if (on || st.verdict === 'none' || !hold || st.dark || st.inverted || tiny || small) img.removeAttribute(WAIT);
    queueBadges();
  }

  function clearTags(img) {
    img.removeAttribute(ATTR);
    img.removeAttribute(ATTR_L);
  }

  // ---------------------------------------------------------------- analysis

  /** Classify a decoded image element on our own canvas; null if the canvas is tainted. */
  function sampleElement(img, svg) {
    const w = img.naturalWidth || img.width || 300;
    const h = img.naturalHeight || img.height || 150;
    try {
      const px = C.pixels(img, w, h, svg);
      return C.classify(px.data, px.w, px.h);
    } catch (e) {
      return null; // cross-origin without CORS: the service worker reads it instead
    }
  }

  /** SVG fetched by the service worker: rasterise it here, where there is a DOM. */
  function sampleSvg(text) {
    return new Promise((resolve) => {
      const im = new Image();
      im.onload = () => resolve(sampleElement(im, true));
      im.onerror = () => resolve(null);
      im.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
    });
  }

  const cacheable = (url) => /^https?:/.test(url) && url.length <= 2048;
  const isSvg = (url) => /^data:image\/svg|\.svg([?#]|$)/i.test(url);
  const loaded = (img, st) => img.complete && (img.naturalWidth > 0 || isSvg(st.src));

  function sameOrigin(url) {
    try { return new URL(url).origin === location.origin; } catch (e) { return false; }
  }

  /** Cross-origin http(s) images are read by the service worker, which needn't wait for load. */
  const remote = (url) => cacheable(url) && !sameOrigin(url);

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch (e) {
      return Promise.resolve(null); // extension was reloaded; this page keeps its last state
    }
  }

  async function analyze(img) {
    const st = state.get(img);
    if (!st) return;
    const src = st.src;
    let res = null, source = 'page';
    if (loaded(img, st) && (!remote(src) || img.crossOrigin !== null)) {
      res = sampleElement(img, isSvg(src));
      if (res && cacheable(src)) send({ type: 'remember', url: src, result: res });
    }
    if (!res && cacheable(src)) {
      source = 'fetched';
      const r = await send({ type: 'analyze', url: src, page: location.href });
      if (r && r.svg) {
        res = await sampleSvg(r.svg);
        if (res) send({ type: 'remember', url: src, result: res });
      } else if (r && r.verdict) {
        res = r;
      }
    }
    if (state.get(img) !== st) return; // the image changed while we waited
    st.pending = false;
    if (st.verdict) return; // the cache or your right-click choice got there first
    st.verdict = res ? res.verdict : 'none';
    st.signals = res ? res.signals : null;
    st.source = res ? source : 'unreadable';
    apply(img);
  }

  const queue = [];
  let running = 0;

  function schedule(img) {
    const st = state.get(img);
    if (!st || st.verdict || st.pending || !isActive()) return;
    if (!loaded(img, st) && !remote(st.src)) return; // same-origin: the load listener calls back
    st.pending = true;
    queue.push(img);
    pump();
  }

  function pump() {
    while (running < 6 && queue.length) {
      const first = queue.findIndex((q) => visible.has(q));
      const img = queue.splice(first >= 0 ? first : 0, 1)[0];
      running++;
      analyze(img).finally(() => { running--; pump(); });
    }
  }

  // Before an image has even loaded, ask the cache: a hit means it is ready on first paint.
  const lookups = new Map(); // url -> Set<img>
  let lookupTimer = 0;

  function lookup(img, st) {
    if (!cacheable(st.src)) return;
    let set = lookups.get(st.src);
    if (!set) lookups.set(st.src, (set = new Set()));
    set.add(img);
    if (!lookupTimer) lookupTimer = setTimeout(flushLookups, 0);
  }

  async function flushLookups() {
    lookupTimer = 0;
    const batch = new Map(lookups);
    lookups.clear();
    const hits = (await send({ type: 'lookup', urls: [...batch.keys()] })) || {};
    for (const [url, imgs] of batch) {
      const hit = hits[url];
      if (!hit) continue;
      for (const img of imgs) {
        const st = state.get(img);
        if (!st || st.src !== url || st.verdict) continue;
        st.verdict = hit.verdict;
        st.signals = hit.signals;
        st.source = 'cache';
        apply(img);
      }
    }
  }

  // --------------------------------------------------------------- discovery

  function consider(img) {
    if (!tracked.has(img)) {
      tracked.add(img);
      io.observe(img);
      seen.observe(img);
    }
    const src = img.currentSrc || img.src || '';
    let st = state.get(img);
    if (st && st.src === src) return st;
    if (st) clearTags(img);
    if (!src) {
      state.delete(img);
      img.removeAttribute(WAIT);
      return null;
    }
    st = { src, verdict: null };
    state.set(img, st);
    const mine = overrides[src] || (img.src && overrides[img.src]);
    if (mine) {
      st.verdict = mine;
      st.source = 'you';
      apply(img);
      return st;
    }
    if (hold) wait(img); // set inside the MutationObserver callback: before first paint
    lookup(img, st);
    if (near.has(img)) schedule(img);
    return st;
  }

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const img = e.target;
      if (!e.isIntersecting) { near.delete(img); continue; }
      near.add(img);
      const st = consider(img);
      if (!st) continue;
      const b = e.boundingClientRect;
      if (b.width > 0 && b.width <= SMALL && b.height <= SMALL) img.removeAttribute(WAIT); // small: show at once
      if (!st.verdict) schedule(img);
      else if (st.stale) apply(img);
    }
  }, { rootMargin: '800px', scrollMargin: '800px' });

  // Off-screen images were tagged from their ancestors' background; measure the real
  // backdrop once they are actually visible.
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) visible.add(e.target);
      else visible.delete(e.target);
      const st = e.isIntersecting && state.get(e.target);
      if (st && st.verdict && st.provisional) apply(e.target);
    }
  });

  document.addEventListener('load', (e) => {
    const img = e.target;
    if (img instanceof HTMLLinkElement) { themeChanged(); return; } // a stylesheet arrived
    if (!(img instanceof HTMLImageElement)) return;
    const st = consider(img);
    if (st && !st.verdict && near.has(img)) schedule(img);
  }, true);

  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    const st = consider(img);
    if (st && !st.verdict) {
      st.verdict = 'none';
      st.source = 'broken';
      apply(img);
    }
  }, true);

  function scan(rootNode) {
    if (rootNode.tagName === 'IMG') consider(rootNode);
    else if (rootNode.querySelectorAll) rootNode.querySelectorAll('img').forEach(consider);
  }

  const domObserver = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes') {
        if (m.target instanceof HTMLImageElement) consider(m.target);
        continue;
      }
      if (m.target.nodeName === 'STYLE' && m.target !== style) themeChanged(); // stylesheet text edited
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'STYLE' || node.tagName === 'LINK') { if (node !== style) themeChanged(); }
        else scan(node);
      }
      for (const node of m.removedNodes) {
        if (node === style) refreshStyle();
        else if (node.nodeType === 1 && (node.tagName === 'STYLE' || node.tagName === 'LINK')) themeChanged();
      }
    }
  });
  domObserver.observe(document, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset'],
  });

  // Theme switches: Dark Reader toggling, the site's own dark-mode class, the OS setting.
  const themeObserver = new MutationObserver((muts) => {
    if (muts.some((m) => m.attributeName !== PEEK)) themeChanged();
  });
  themeObserver.observe(document.documentElement, { attributes: true });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => themeChanged());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) themeChanged(); });

  // Backstop for theme changes no observer sees (stylesheets edited through the CSSOM).
  let lastDark = null;
  setInterval(() => {
    if (document.hidden || !ready || !document.body) return;
    const dark = pageLightness() <= DARK_PAGE;
    if (lastDark !== null && dark !== lastDark) themeChanged();
    lastDark = dark;
  }, 1000);

  // Re-check in the next animation frame, i.e. before the theme change is ever painted.
  let themeFrame = 0;
  function themeChanged() {
    if (!themeFrame) themeFrame = requestAnimationFrame(() => { themeFrame = 0; reevaluate(); });
  }

  function reevaluate() {
    if (!ready) return;
    const wasActive = isActive();
    detectFilterMode();
    if (wasActive !== isActive()) refreshStyle();
    rememberDarkness();
    updateHold();
    for (const img of tracked) {
      if (!img.isConnected) { tracked.delete(img); io.unobserve(img); seen.unobserve(img); continue; }
      const st = state.get(img);
      if (!st) continue;
      if (!st.verdict) { if (near.has(img)) schedule(img); continue; }
      if (near.has(img)) apply(img);
      else st.stale = true;
    }
    queueBadges();
  }

  /** Remember whether this site is dark, so the next visit hides images from the first byte. */
  function rememberDarkness() {
    if (!document.body) return;
    const dark = pageLightness() <= DARK_PAGE;
    if (dark && !knownDark) {
      knownDark = true;
      chrome.storage.local.set({ [DARK_KEY]: true }).catch(() => {});
    } else if (!dark && knownDark && document.readyState === 'complete') {
      knownDark = false;
      chrome.storage.local.remove(DARK_KEY).catch(() => {});
    }
  }

  // -------------------------------------------------------------------- peek

  function setPeek(on) {
    const html = document.documentElement;
    if (on) html.setAttribute(PEEK, '');
    else html.removeAttribute(PEEK);
  }
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Alt' && settings.peek === 'alt' && !e.repeat) setPeek(true);
  }, true);
  window.addEventListener('keyup', (e) => { if (e.key === 'Alt') setPeek(false); }, true);
  window.addEventListener('blur', () => setPeek(false));
  document.addEventListener('visibilitychange', () => setPeek(false));

  // ------------------------------------------------------------------ badges

  let badgeLayer = null;
  let badgeFrame = 0;
  const BADGE_COLORS = { flip: '#f2b45a', logo: '#5fd0c0', dim: '#b9a3ff', none: '#8a8f98' };

  function queueBadges() {
    if (!badgeFrame && (settings.badges || badgeLayer)) {
      badgeFrame = requestAnimationFrame(drawBadges);
    }
  }

  function drawBadges() {
    badgeFrame = 0;
    if (!settings.badges || !isActive()) {
      if (badgeLayer) { badgeLayer.host.remove(); badgeLayer = null; }
      return;
    }
    if (!badgeLayer) {
      const host = document.createElement('inkflip-badges');
      host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647';
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>
        b{position:fixed;font:600 11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#111;
          padding:1px 6px;border-radius:5px;white-space:nowrap;box-shadow:0 1px 4px #0008}
        b i{font-style:normal;font-weight:400;opacity:.75}
      </style><div></div>`;
      document.documentElement.appendChild(host);
      badgeLayer = { host, list: root.querySelector('div') };
    }
    const vw = innerWidth, vh = innerHeight;
    let html = '';
    for (const img of tracked) {
      const st = state.get(img);
      if (!st || !st.verdict || !img.isConnected) continue;
      const r = img.getBoundingClientRect();
      if (r.width < 24 || r.height < 16 || r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) continue;
      const shown = img.hasAttribute(ATTR_L) ? st.verdict : 'none';
      const why = st.source === 'you' ? 'your choice'
        : !st.dark ? 'page is light' : st.inverted ? 'already inverted'
        : st.signals ? `tone ${st.signals.tone.toFixed(2)} · fg ${st.signals.fg90}` : st.source;
      html += `<b style="left:${Math.max(0, r.left) + 4}px;top:${Math.max(0, r.top) + 4}px;` +
        `background:${BADGE_COLORS[shown]}">${shown} <i>${why}</i></b>`;
    }
    badgeLayer.list.innerHTML = html;
  }
  addEventListener('scroll', queueBadges, { capture: true, passive: true });
  addEventListener('resize', queueBadges, { passive: true });

  // ---------------------------------------------------------------- settings

  function treatmentOn(verdict) {
    return verdict === 'flip' ? settings.flip : verdict === 'logo' ? settings.logo
      : verdict === 'dim' ? settings.dim : false;
  }

  function stats() {
    const counts = { flip: 0, logo: 0, dim: 0, none: 0, pending: 0 };
    for (const img of tracked) {
      if (!img.isConnected) continue;
      const st = state.get(img);
      if (!st) continue;
      if (!st.verdict) { if (st.pending) counts.pending++; continue; }
      const shown = img.hasAttribute(ATTR_L) && treatmentOn(st.verdict) ? st.verdict : 'none';
      counts[shown]++;
    }
    return {
      counts, host: HOST, active: isActive(), filterMode,
      pageDark: pageLightness() <= DARK_PAGE, darkReader: detectDarkReader(),
    };
  }

  function applyOverrides() {
    for (const img of tracked) {
      const st = state.get(img);
      if (!st) continue;
      const mine = overrides[st.src];
      if (mine) {
        st.verdict = mine;
        st.source = 'you';
      } else if (st.source === 'you') {
        st.verdict = null;
        st.source = null;
        st.pending = false;
        clearTags(img);
        lookup(img, st);
        schedule(img);
        continue;
      }
      if (st.verdict) apply(img);
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) {
      settings = { ...DEFAULTS, ...changes.settings.newValue };
      refreshStyle();
      reevaluate();
    }
    if (area === 'local' && changes[OVR_KEY]) {
      overrides = changes[OVR_KEY].newValue || {};
      applyOverrides();
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg && msg.type === 'stats' && isTop) reply(stats());
  });

  function topHost() {
    if (window === window.top) return location.hostname;
    const ao = location.ancestorOrigins;
    if (ao && ao.length) {
      try { return new URL(ao[ao.length - 1]).hostname; } catch (e) { /* fall through */ }
    }
    return location.hostname;
  }

  // -------------------------------------------------------------------- start

  refreshStyle();
  scan(document);

  Promise.all([
    chrome.storage.sync.get('settings'),
    chrome.storage.local.get([OVR_KEY, DARK_KEY]),
  ]).then(([s, local]) => {
    settings = { ...DEFAULTS, ...(s.settings || {}) };
    overrides = local[OVR_KEY] || {};
    knownDark = !!local[DARK_KEY];
    ready = true;
    detectFilterMode();
    refreshStyle();
    applyOverrides();
    reevaluate();
  }).catch(() => {
    ready = true; // storage unavailable: run with defaults rather than hide images
    refreshStyle();
    reevaluate();
  });

  document.addEventListener('DOMContentLoaded', () => {
    scan(document);
    if (document.body) themeObserver.observe(document.body, { attributes: true });
    themeChanged();
  });
  addEventListener('load', () => themeChanged());
})();

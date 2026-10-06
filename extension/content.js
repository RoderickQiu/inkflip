/*
 * Inkflip content script.
 *
 * Finds <img> and <canvas> elements, gets a verdict for each one (from the user's right-click
 * choice, the shared cache, or by sampling its pixels), and tags it with
 * data-inkflip="flip|logo|dim|none". A <video> is only ever tagged by a right-click choice.
 * A single injected stylesheet turns those tags into CSS filters, but only while the element
 * actually sits on a dark background, which is what data-inkflip-l (the backdrop's lightness)
 * records. Page colours, CSS background images and inline SVG are left to Dark Reader.
 *
 * No white flash: on dark pages a new image carries data-inkflip-wait (opacity 0) from the
 * moment it enters the DOM until its verdict is in, so it first appears already flipped.
 * A canvas is held the same way while it is still blank, but for at most CANVAS_HOLD once it
 * is on screen: a WebGL canvas reads back blank forever and must not stay hidden.
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
  const CANVAS_HOLD = 500; // ms a blank canvas on screen may stay hidden, waiting to be painted
  const RECHECK = [300, 1000, 2500, 6000]; // ms after a canvas verdict: charts animate in,
                                           // PDF pages render in passes

  const HOST = topHost();
  const OVR_KEY = 'ovr:' + HOST;
  const DARK_KEY = 'dark:' + HOST;
  const isTop = window === window.top;

  let settings = { ...DEFAULTS };
  let overrides = {}; // image URL, canvas or video key -> 'flip' | 'dim' | 'none', from the right-click menu
  let ready = false; // settings have been read
  let knownDark = false; // this site was dark last time, so hold images from the first byte
  let hold = true; // hide unchecked images (true until settings say otherwise)
  let filterMode = false; // the whole page is inverted (Dark Reader's Filter mode or similar)

  const state = new WeakMap(); // element -> { kind, verdict, signals, source, provisional, ... }
  const tracked = new Set();
  const near = new WeakSet(); // elements within the IntersectionObserver margin
  const visible = new WeakSet(); // elements actually on screen: checked first

  const isImg = (el) => el instanceof HTMLImageElement;
  const isCanvas = (el) => el instanceof HTMLCanvasElement;
  const isVideo = (el) => el instanceof HTMLVideoElement;
  const isMedia = (el) => isImg(el) || isCanvas(el) || isVideo(el);

  // ---------------------------------------------------------------- stylesheet

  const style = document.createElement('style');
  style.id = 'inkflip-style';

  function isActive() {
    return ready && settings.enabled && !filterMode && !settings.disabledHosts.includes(HOST);
  }

  function buildCss() {
    let css = '';
    if (!ready || (isActive() && settings.hold)) css += `:is(img,canvas)[${WAIT}]{opacity:0 !important}\n`;
    if (!isActive()) return css;
    const hover = settings.peek === 'hover' ? ':not(:hover)' : '';
    const on = (v) => `html:not([${PEEK}]) :is(img,canvas,video)[${ATTR}="${v}"]`;
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
    if (isVideo(img) || img.hasAttribute(WAIT)) return;
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
      if (st.kind === 'canvas') {
        // Its own polling reveals it after CANVAS_HOLD; this is the backstop.
        if (visible.has(img)) {
          st.t0 = st.t0 || now;
          if (now - st.t0 > CANVAS_HOLD + 1000) img.removeAttribute(WAIT);
        }
      } else if (near.has(img) && img.complete) {
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
    const [nw, nh] = natural(img);
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

  /** Intrinsic size: an image's pixels, a canvas's bitmap, a video's frames. */
  function natural(el) {
    if (isCanvas(el)) return [el.width, el.height];
    if (isVideo(el)) return [el.videoWidth, el.videoHeight];
    return [el.naturalWidth, el.naturalHeight];
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

  // ---------------------------------------------------------------- canvases
  //
  // A canvas has no load event and no URL: the page paints it whenever it likes, and may paint
  // it again. So it is sampled when it comes near the screen, polled while it is still blank,
  // and looked at a few more times after its verdict (charts animate in, PDF pages render in
  // passes, a resize clears it). Once it has a verdict, two samples in a row must agree before
  // it changes. A canvas holding a cross-origin picture can't be read, and WebGL reads back
  // blank or a stray frame: both are left alone (a right-click choice still applies).

  /** Verdict for a canvas's current pixels, or 'blank' (nothing painted) or 'tainted'. */
  function sampleCanvas(cv) {
    const w = cv.width, h = cv.height;
    if (w < 8 || h < 8) return 'blank';
    const [tw, th] = C.sampleSize(w, h);
    try {
      // Shrink it on the GPU first: reading a full-size canvas back into memory is slow.
      const small = new OffscreenCanvas(tw, th);
      const g = small.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.drawImage(cv, 0, 0, tw, th);
      const px = C.pixels(small, tw, th, false);
      const res = C.classify(px.data, px.w, px.h);
      return res.signals.transp > 0.998 ? 'blank' : res;
    } catch (e) {
      return 'tainted'; // a cross-origin image was drawn into it
    }
  }

  /**
   * Whether a canvas keeps its pixels between frames, so that a sample means something.
   * WebGL and WebGPU drop each frame once it is on screen: a sample reads blank, or whichever
   * frame it happened to catch. Only asked once the canvas has shown content, so it already
   * has a context and asking for another one creates nothing: it just returns null.
   */
  function steady(cv) {
    try {
      return !!(cv.getContext('2d') || cv.getContext('bitmaprenderer'));
    } catch (e) {
      return true; // stands in for an OffscreenCanvas, and shows its last committed frame
    }
  }

  function later(cv, st, ms) {
    clearTimeout(st.timer);
    st.timer = setTimeout(canvasTick, ms, cv);
  }

  /** Start sampling a canvas; `fresh` starts its checks over (after a resize, say). */
  function startCanvas(cv, fresh) {
    const st = state.get(cv);
    if (!st || st.source === 'you' || st.gl || !isActive()) return;
    if (fresh) {
      st.checks = 0;
      st.t0 = 0;
    }
    if (!st.timer) later(cv, st, 0);
  }

  function settle(cv, st, verdict, signals, source) {
    st.verdict = verdict;
    st.signals = signals;
    st.source = source;
    apply(cv);
  }

  function recheck(cv, st) {
    const ms = RECHECK[st.checks];
    if (ms === undefined) return;
    st.checks++;
    later(cv, st, ms);
  }

  function canvasTick(cv) {
    const st = state.get(cv);
    if (!st) return;
    st.timer = 0;
    if (!cv.isConnected || !isActive() || st.source === 'you') return;
    const mine = overrideFor(cv, st); // its parents' classes may have changed since it was found
    if (mine) {
      settle(cv, st, mine, null, 'you');
      return;
    }
    const now = performance.now();
    const res = sampleCanvas(cv);
    st.sampled = now;
    if (res === 'tainted') {
      if (!st.verdict || st.source === 'blank') settle(cv, st, 'none', null, 'unreadable');
      return;
    }
    if (res === 'blank') {
      if (st.verdict && st.source !== 'blank') { recheck(cv, st); return; } // cleared for a redraw
      if (!visible.has(cv)) { st.t0 = 0; return; } // polled again once it is on screen
      st.t0 = st.t0 || now;
      const age = now - st.t0;
      if (age >= CANVAS_HOLD) cv.removeAttribute(WAIT);
      if (age < (st.gaveUp ? 2000 : 15000)) {
        later(cv, st, age < CANVAS_HOLD ? 16 : age < 3000 ? 200 : 1000);
      } else {
        st.gaveUp = true;
        st.t0 = 0;
        settle(cv, st, 'none', null, 'blank');
      }
      return;
    }
    if (st.gl === undefined) st.gl = !steady(cv);
    if (st.gl) {
      settle(cv, st, 'none', null, 'webgl');
      cv.removeAttribute(WAIT);
      return;
    }
    const firm = st.verdict && st.source === 'page';
    if (firm && res.verdict !== st.verdict && st.candidate !== res.verdict) {
      st.candidate = res.verdict; // maybe caught mid-redraw: look again before switching
      later(cv, st, 150);
      return;
    }
    st.candidate = null;
    settle(cv, st, res.verdict, res.signals, 'page');
    recheck(cv, st);
  }

  /** Setting a canvas's width or height clears it: watch it repaint. */
  function canvasResized(cv) {
    const st = state.get(cv);
    if (!st || (cv.width === st.w && cv.height === st.h)) return;
    st.w = cv.width;
    st.h = cv.height;
    if (near.has(cv)) startCanvas(cv, true);
  }

  // ------------------------------------------------------- right-click choices

  /**
   * What a right-click choice on a canvas is remembered by, for this site: its id, and the
   * tags and class names of the parents it sits in. Every page of a PDF viewer shares one,
   * as do the charts of one kind on a site. Class names with digits in them are left out,
   * because they tend to be generated, and so is the canvas's own class list, which chart
   * libraries change after they start.
   */
  function canvasKey(cv) {
    const id = cv.id && !/\d/.test(cv.id) ? '#' + cv.id : '';
    const parts = ['canvas' + id];
    let n = cv.parentElement;
    for (let i = 0; i < 3 && n && n !== document.body && n !== document.documentElement; i++, n = n.parentElement) {
      const cls = [...n.classList].filter((c) => !/\d/.test(c) && c.length <= 40).sort().slice(0, 3);
      parts.unshift(n.localName + cls.map((c) => '.' + c).join(''));
    }
    return 'canvas|' + parts.join('>');
  }

  /**
   * What a right-click choice on a video is remembered by: its file, when it has a real
   * address, or else this page and its place on it (streamed video plays from a blob: URL
   * that changes on every visit).
   */
  function videoKey(v) {
    const src = v.currentSrc || v.src || '';
    if (cacheable(src)) return src;
    const n = [...document.getElementsByTagName('video')].indexOf(v);
    return `video|${location.origin}${location.pathname}${location.search}|${n}`;
  }

  function overrideFor(el, st) {
    if (isImg(el)) return overrides[st.src] || (el.src && overrides[el.src]) || null;
    return overrides[isCanvas(el) ? canvasKey(el) : st.key] || null;
  }

  // --------------------------------------------------------------- discovery

  function consider(el) {
    if (!tracked.has(el)) {
      tracked.add(el);
      io.observe(el);
      seen.observe(el);
    }
    if (isImg(el)) return considerImage(el);
    let st = state.get(el);
    if (st) {
      if (st.kind === 'video') refreshVideo(el, st);
      return st;
    }
    st = isCanvas(el)
      ? { kind: 'canvas', verdict: null, w: el.width, h: el.height, checks: 0, t0: 0, timer: 0 }
      : { kind: 'video', verdict: null, key: videoKey(el) };
    state.set(el, st);
    const mine = overrideFor(el, st);
    if (mine) {
      st.verdict = mine;
      st.source = 'you';
      apply(el);
    } else if (st.kind === 'canvas') {
      if (hold) wait(el); // set inside the MutationObserver callback: before first paint
      if (near.has(el)) startCanvas(el, true);
    }
    return st;
  }

  /** A video's source or the page address changed (YouTube reuses one element throughout). */
  function refreshVideo(v, st) {
    const key = videoKey(v);
    if (key === st.key) return;
    st.key = key;
    const mine = overrides[key];
    if (mine) {
      st.verdict = mine;
      st.source = 'you';
      apply(v);
    } else if (st.verdict) {
      st.verdict = null;
      st.source = null;
      clearTags(v);
      queueBadges();
    }
  }

  /** Get a verdict under way, whatever kind of element it is. */
  function check(el) {
    if (isImg(el)) schedule(el);
    else if (isCanvas(el)) startCanvas(el, false);
  }

  function considerImage(img) {
    const src = img.currentSrc || img.src || '';
    let st = state.get(img);
    if (st && st.src === src) return st;
    if (st) clearTags(img);
    if (!src) {
      state.delete(img);
      img.removeAttribute(WAIT);
      return null;
    }
    st = { kind: 'img', src, verdict: null };
    state.set(img, st);
    const mine = overrideFor(img, st);
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
      const el = e.target;
      if (!e.isIntersecting) { near.delete(el); continue; }
      near.add(el);
      const st = consider(el);
      if (!st) continue;
      const b = e.boundingClientRect;
      if (b.width > 0 && b.width <= SMALL && b.height <= SMALL) el.removeAttribute(WAIT); // small: show at once
      if (!st.verdict) check(el);
      else if (st.stale) apply(el);
    }
  }, { rootMargin: '800px', scrollMargin: '800px' });

  // Off-screen elements were tagged from their ancestors' background; measure the real
  // backdrop once they are actually visible. A canvas back on screen is polled again if it
  // was blank, or looked at once more if it may have been repainted since.
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const el = e.target;
      if (e.isIntersecting) visible.add(el);
      else visible.delete(el);
      const st = e.isIntersecting && state.get(el);
      if (!st) continue;
      if (st.verdict && st.provisional) apply(el);
      if (st.kind !== 'canvas') continue;
      if (!st.verdict || st.source === 'blank') startCanvas(el, false);
      else if (performance.now() - (st.sampled || 0) > 5000) startCanvas(el, true);
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
    if (isMedia(rootNode)) consider(rootNode);
    else if (rootNode.querySelectorAll) rootNode.querySelectorAll('img,canvas,video').forEach(consider);
  }

  const domObserver = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes') {
        const t = m.target;
        if (isImg(t)) consider(t);
        else if (isCanvas(t)) canvasResized(t);
        else if (isVideo(t) && m.attributeName === 'src' && state.has(t)) consider(t);
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
    childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'width', 'height'],
  });

  // Theme switches: Dark Reader toggling, the site's own dark-mode class, the OS setting.
  const themeObserver = new MutationObserver((muts) => {
    if (muts.some((m) => m.attributeName !== PEEK)) themeChanged();
  });
  themeObserver.observe(document.documentElement, { attributes: true });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => themeChanged());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) themeChanged(); });

  // Backstop for theme changes no observer sees (stylesheets edited through the CSSOM).
  // Also notices single-page navigation, which gives a reused <video> a new identity.
  let lastDark = null;
  let lastHref = location.href;
  setInterval(() => {
    if (document.hidden || !ready || !document.body) return;
    if (location.href !== lastHref) {
      lastHref = location.href;
      for (const el of tracked) if (isVideo(el) && state.has(el)) consider(el);
    }
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
    for (const el of tracked) {
      if (!el.isConnected) { tracked.delete(el); io.unobserve(el); seen.unobserve(el); continue; }
      const st = state.get(el);
      if (!st) continue;
      if (!st.verdict) { if (near.has(el)) check(el); continue; }
      if (near.has(el)) apply(el);
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

  // -------------------------------------------------------- right-click menu
  //
  // Chrome itself offers Inkflip's menu when you right-click an image or a video. A canvas,
  // or an image or video under a transparent layer (pdf.js's text layer, YouTube's controls),
  // gets no menu of its own, so this script tells the service worker what is under the
  // pointer and it shows a second menu while there is one. When a choice is made, the service
  // worker asks this frame what was right-clicked.

  let menuTarget = null; // the image, canvas or video under the last right-click
  let reported; // what this document last told the service worker; undefined: tell it again
  let px = -1, py = -1, pointerTimer = 0;

  /** The image, canvas or video visible at a point, looking through transparent layers. */
  function mediaAt(x, y) {
    const stack = document.elementsFromPoint(x, y);
    for (let i = 0; i < stack.length; i++) {
      const el = stack[i];
      if (isMedia(el)) return { el, direct: i === 0 };
      if (el instanceof HTMLIFrameElement || el instanceof HTMLFrameElement ||
          el instanceof HTMLEmbedElement || el instanceof HTMLObjectElement) return { frame: true };
      const c = parseColor(getComputedStyle(el).backgroundColor);
      if (c && c.a >= 0.5) break; // an opaque layer hides whatever is below it
    }
    return {};
  }

  function report(kind) {
    if (kind === reported) return;
    reported = kind;
    send({ type: 'menu', kind, t: Date.now() });
  }

  function reportAt(x, y) {
    const hit = mediaAt(x, y);
    if (hit.frame) return; // the frame's own copy of this script reports
    // A directly hit image or video already has Chrome's own menu.
    report(!hit.el || (hit.direct && !isCanvas(hit.el)) ? null : isVideo(hit.el) ? 'video' : 'image');
  }

  function pointerMoved() {
    if (pointerTimer || px < 0) return;
    reportAt(px, py);
    pointerTimer = setTimeout(() => { pointerTimer = 0; reportAt(px, py); }, 100);
  }

  addEventListener('pointermove', (e) => {
    px = e.clientX;
    py = e.clientY;
    pointerMoved();
  }, { capture: true, passive: true });
  // Entering this document from outside it (or from a parent frame): report afresh.
  addEventListener('pointerover', (e) => { if (!e.relatedTarget) reported = undefined; }, { capture: true, passive: true });
  document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) report(null); }, true);
  addEventListener('focus', () => { reported = undefined; });
  document.addEventListener('visibilitychange', () => { reported = undefined; });
  for (const type of ['mousedown', 'contextmenu']) {
    addEventListener(type, (e) => {
      if (type === 'mousedown' && e.button !== 2) return;
      menuTarget = mediaAt(e.clientX, e.clientY).el || null;
      reportAt(e.clientX, e.clientY);
    }, true);
  }

  /** The key a right-click choice on the last right-clicked element is stored under. */
  function menuKey() {
    const el = menuTarget;
    if (!el || !el.isConnected) return null;
    const st = consider(el);
    if (!st) return null;
    return st.kind === 'img' ? st.src : st.kind === 'canvas' ? canvasKey(el) : st.key;
  }

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
  addEventListener('scroll', () => { queueBadges(); pointerMoved(); }, { capture: true, passive: true });
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
    for (const el of tracked) {
      const st = state.get(el);
      if (!st) continue;
      const mine = overrideFor(el, st);
      if (mine) {
        st.verdict = mine;
        st.source = 'you';
      } else if (st.source === 'you') {
        st.verdict = null;
        st.source = null;
        clearTags(el);
        if (st.kind === 'img') {
          st.pending = false;
          lookup(el, st);
          schedule(el);
        } else if (st.kind === 'canvas') {
          if (st.gl) settle(el, st, 'none', null, 'webgl');
          else startCanvas(el, true);
        }
        queueBadges();
        continue;
      }
      if (st.verdict) apply(el);
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
    if (!msg) return;
    if (msg.type === 'stats' && isTop) reply(stats());
    else if (msg.type === 'menu-target') reply(menuKey());
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
